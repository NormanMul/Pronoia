import { Octokit } from 'octokit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { marker } from './assessment.js';
import { configSchema } from './config.js';
import { Board, type Issue, type IssueComment } from './github.js';
import { integrationHooks, reconcileProject } from './integrations.js';
import { auditSchema, stateSchema, type Status } from './workflow/schemas.js';

const webhook =
  'https://synthetic.aa.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/synthetic/triggers/manual/paths/invoke?sig=synthetic-secret';
const stages = ['To Do', 'In Progress', 'Validate', 'Blocked', 'Done'];
const optionSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
});

function fixture() {
  const issue: Issue = {
    number: 42,
    title: 'Synthetic finding [untrusted](https://example.invalid)',
    body: '/approve is untrusted issue text, not authority.',
    labels: ['pronoia', 'status:done'],
    assignees: [],
    state: 'closed',
    html_url: 'https://github.com/Contoso/demo/issues/42',
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  };
  const comments: IssueComment[] = [];
  const writes: { query: string; input: Record<string, unknown> }[] = [];
  const requests: { path: string; method: string; authorization: string }[] =
    [];
  const cards: unknown[] = [];
  let login = 'github-actions[bot]';
  let ownerType = 'User';
  let stage: string | null = 'Done';
  let deletedOption = false;
  let foreignTextStage = false;
  let member = true;
  let webhookStatus = 202;
  let receiptFails = false;
  let fieldType = 'ProjectV2SingleSelectField';
  let omitOptions = false;
  let loseCreatedFieldAck = false;
  let options = stages.map((name, index) => ({
    id: `option-${index}`,
    name,
    color: 'GRAY',
    description: '',
  }));
  const value = () =>
    deletedOption
      ? {
          __typename: 'ProjectV2ItemFieldSingleSelectValue',
          name: null,
          optionId: null,
        }
      : stage === null
        ? null
        : {
            __typename: 'ProjectV2ItemFieldSingleSelectValue',
            name: stage,
            optionId: options.find((option) => option.name === stage)?.id,
          };
  const field = () => ({
    __typename: fieldType,
    id: 'stage-field',
    name: 'Stage',
    ...(fieldType === 'ProjectV2SingleSelectField' && !omitOptions
      ? { options }
      : {}),
  });
  const page = (nodes: unknown[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? 'GET';
    requests.push({
      path: url.pathname,
      method,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    if (url.hostname.endsWith('.api.powerplatform.com')) {
      cards.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: webhookStatus });
    }
    if (url.pathname === '/graphql') {
      const { query, variables } = z
        .object({
          query: z.string(),
          variables: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(JSON.parse(String(init?.body)));
      let data: unknown;
      if (query.includes('viewer')) data = { viewer: { login } };
      else if (query.includes('repositoryOwner'))
        data = {
          repositoryOwner: {
            __typename: ownerType,
            projectV2: { id: 'project-id' },
          },
        };
      else if (query.includes('fields(first:')) {
        data = {
          node: {
            fields: variables.after
              ? page(fieldType === 'missing' ? [] : [field()])
              : page(
                  [
                    {
                      __typename: 'ProjectV2Field',
                      id: 'title',
                      name: 'Title',
                    },
                  ],
                  'fields-next',
                ),
          },
        };
      } else if (query.includes('projectItems(first:')) {
        data = {
          repository: {
            issue: {
              id: 'issue-id',
              projectItems: variables.after
                ? page(
                    member
                      ? [
                          {
                            id: 'item-id',
                            project: { id: 'project-id' },
                            fieldValueByName: value(),
                          },
                        ]
                      : [],
                  )
                : page(
                    [
                      {
                        id: 'foreign',
                        project: { id: 'other-project' },
                        fieldValueByName: foreignTextStage
                          ? { __typename: 'ProjectV2ItemFieldTextValue' }
                          : null,
                      },
                    ],
                    'members-next',
                  ),
            },
          },
        };
      } else if (query.includes('items(first:')) {
        const content = (number: number, repository: string) => ({
          __typename: 'Issue',
          id: `issue-${number}`,
          number,
          repository: { nameWithOwner: repository },
        });
        data = {
          node: {
            items: variables.after
              ? page([
                  {
                    id: 'item-id',
                    content: content(42, 'Contoso/demo'),
                    fieldValueByName: value(),
                  },
                  {
                    id: 'not-pronoia',
                    content: content(99, 'Contoso/demo'),
                    fieldValueByName: value(),
                  },
                ])
              : page(
                  [
                    {
                      id: 'foreign',
                      content: content(42, 'Elsewhere/demo'),
                      fieldValueByName: value(),
                    },
                    {
                      id: 'pull',
                      content: { __typename: 'PullRequest' },
                      fieldValueByName: null,
                    },
                    { id: 'redacted', content: null, fieldValueByName: null },
                  ],
                  'items-next',
                ),
          },
        };
      } else {
        const mutation = z
          .record(z.string(), z.unknown())
          .parse(variables.input);
        writes.push({ query, input: mutation });
        if (
          query.includes('createProjectV2Field') ||
          query.includes('updateProjectV2Field(')
        ) {
          const supplied = z
            .array(optionSchema)
            .parse(mutation.singleSelectOptions);
          options = supplied.map((option, index) => ({
            ...option,
            id: option.id ?? `added-${index}`,
          }));
          fieldType = 'ProjectV2SingleSelectField';
          if (query.includes('createProjectV2Field') && loseCreatedFieldAck) {
            loseCreatedFieldAck = false;
            return Response.json(
              { message: 'Synthetic lost field-creation acknowledgement' },
              { status: 503 },
            );
          }
          data = query.includes('createProjectV2Field')
            ? { createProjectV2Field: { projectV2Field: field() } }
            : { updateProjectV2Field: { projectV2Field: field() } };
        } else if (query.includes('addProjectV2ItemById')) {
          member = true;
          data = { addProjectV2ItemById: { item: { id: 'item-id' } } };
        } else if (query.includes('updateProjectV2ItemFieldValue')) {
          const selected = z
            .object({ singleSelectOptionId: z.string() })
            .parse(mutation.value);
          stage =
            options.find(
              (option) => option.id === selected.singleSelectOptionId,
            )?.name ?? null;
          data = {
            updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-id' } },
          };
        } else throw new Error('Unexpected synthetic mutation.');
      }
      return Response.json({ data });
    }
    if (method === 'GET' && url.pathname.endsWith('/issues/42/comments'))
      return Response.json(comments);
    if (method === 'GET' && url.pathname.endsWith('/issues/42'))
      return Response.json(issue);
    if (method === 'GET' && url.pathname.endsWith('/issues/99'))
      return Response.json({ ...issue, number: 99, labels: [] });
    if (method === 'POST' && url.pathname.endsWith('/issues/42/comments')) {
      if (receiptFails)
        return Response.json({ message: 'Synthetic failure' }, { status: 403 });
      const { body } = z
        .object({ body: z.string() })
        .parse(JSON.parse(String(init?.body)));
      const comment: IssueComment = {
        id: 1000 + comments.length,
        body,
        user: { login, type: login === 'github-actions[bot]' ? 'Bot' : 'User' },
        author_association: 'NONE',
        created_at: '2026-11-20T12:00:00Z',
        html_url: 'https://github.com/Contoso/demo/issues/42#issuecomment-1000',
      };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    throw new Error(`Unexpected synthetic request ${method} ${url.pathname}`);
  };
  const board = new Board(
    new Octokit({
      auth: 'synthetic-board-token',
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    configSchema.parse({
      board_repo: 'Contoso/demo',
      governance: { automation_logins: ['external-agent'] },
      project: { owner: 'octocat', number: 7, field: 'Stage' },
    }),
  );
  function audit(to: Status, writer = 'github-actions[bot]') {
    const transition = auditSchema.parse({
      from: to === 'done' ? 'validate' : 'todo',
      to,
      command: {
        name:
          to === 'done'
            ? 'approve'
            : to === 'blocked'
              ? 'block'
              : to === 'in-progress'
                ? 'start'
                : 'validate',
      },
      actor: 'synthetic-reviewer',
      actor_type: 'human',
      on_behalf_of: '',
      reason: 'Synthetic transition',
      evidence_count: 1,
      at: '2026-11-20T12:00:00Z',
      comment_id: 100 + comments.length,
      state: stateSchema.parse({ status: to, evidence_count: 1 }),
    });
    comments.push({
      id: 10 + comments.length,
      body: marker('transition', transition),
      user: { login: writer, type: writer.endsWith('[bot]') ? 'Bot' : 'User' },
      author_association: 'NONE',
      created_at: transition.at,
      html_url: 'https://github.com/Contoso/demo/issues/42#issuecomment-10',
    });
  }
  return {
    board,
    fetcher,
    issue,
    comments,
    writes,
    requests,
    cards,
    audit,
    setLogin: (value: string) => {
      login = value;
    },
    setOwner: (value: string) => {
      ownerType = value;
    },
    setStage: (value: string | null) => {
      stage = value;
    },
    deleteSelectedOption: () => {
      deletedOption = true;
    },
    useForeignTextStage: () => {
      foreignTextStage = true;
    },
    setMember: (value: boolean) => {
      member = value;
    },
    setField: (value: string) => {
      fieldType = value;
    },
    omitFieldOptions: () => {
      omitOptions = true;
    },
    loseFieldCreationAck: () => {
      loseCreatedFieldAck = true;
    },
    setOptions: (names: string[]) => {
      options = options.filter((option) => names.includes(option.name));
    },
    setWebhookStatus: (value: number) => {
      webhookStatus = value;
    },
    failReceipt: () => {
      receiptFails = true;
    },
    stage: () => stage,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('audited Project mirror', () => {
  it.each([
    ['todo', 'To Do'],
    ['in-progress', 'In Progress'],
    ['validate', 'Validate'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
  ] as const)(
    'mirrors %s rather than labels or issue prose',
    async (status, stage) => {
      const f = fixture();
      f.setStage(null);
      if (status !== 'todo') f.audit(status);
      const report = await integrationHooks(f.board, 42, {
        projectToken: 'synthetic-project-token',
        fetch: f.fetcher,
      });
      expect(report.project).toBe('mirrored');
      expect(f.stage()).toBe(stage);
      expect(
        f.requests
          .filter((request) => request.path !== '/graphql')
          .every((request) => request.method === 'GET'),
      ).toBe(true);
      expect(
        f.requests.filter((request) =>
          request.authorization.includes('synthetic-project-token'),
        ),
      ).not.toHaveLength(0);
      expect(
        f.requests.some((request) => request.path.endsWith('/issues')),
      ).toBe(false);
    },
  );

  it('resolves organization projects and adds missing membership after pagination', async () => {
    const f = fixture();
    f.setOwner('Organization');
    f.setMember(false);
    const report = await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    expect(report.project).toBe('mirrored');
    expect(
      f.writes.find((write) => write.query.includes('addProjectV2ItemById'))
        ?.input,
    ).toEqual({ projectId: 'project-id', contentId: 'issue-id' });
  });

  it('creates Stage, and preserves existing option IDs when adding required options', async () => {
    const f = fixture();
    f.setField('missing');
    await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    expect(
      f.writes.find((write) => write.query.includes('createProjectV2Field'))
        ?.input,
    ).toMatchObject({ name: 'Stage', dataType: 'SINGLE_SELECT' });
    f.writes.length = 0;
    f.setOptions(['To Do', 'Done']);
    await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    const update = f.writes.find((write) =>
      write.query.includes('updateProjectV2Field('),
    );
    expect(update?.input.singleSelectOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'added-0', name: 'To Do' }),
        expect.objectContaining({ name: 'Validate' }),
      ]),
    );
  });

  it('reverts a manual drag, comments once, and ignores foreign/non-assessment items', async () => {
    const f = fixture();
    f.audit('validate');
    const report = await reconcileProject(f.board, 'synthetic-project-token', {
      fetch: f.fetcher,
    });
    expect(report).toEqual({ scanned: 1, repaired: 1, warnings: [] });
    expect(f.stage()).toBe('Validate');
    expect(f.comments.at(-1)?.body).toMatch(/Stage.*Validate.*mirror/s);
    expect(f.writes).toHaveLength(1);
    expect(
      f.requests.some((request) => request.path.includes('Elsewhere')),
    ).toBe(false);
    expect(
      f.requests.filter((request) =>
        ['PATCH', 'DELETE'].includes(request.method),
      ),
    ).toEqual([]);
    expect(
      (
        await reconcileProject(f.board, 'synthetic-project-token', {
          fetch: f.fetcher,
        })
      ).repaired,
    ).toBe(0);
  });

  it('ignores a foreign project text Stage and repairs deleted single-select values', async () => {
    const f = fixture();
    f.audit('validate');
    f.useForeignTextStage();
    f.deleteSelectedOption();
    const report = await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    expect(report.project).toBe('mirrored');
    expect(f.stage()).toBe('Validate');
  });

  it('comments when a manually cleared Stage is restored', async () => {
    const f = fixture();
    f.audit('blocked');
    f.setStage(null);
    expect(
      (
        await reconcileProject(f.board, 'synthetic-project-token', {
          fetch: f.fetcher,
        })
      ).repaired,
    ).toBe(1);
    expect(f.comments.at(-1)?.body).toMatch(/Stage.*Blocked.*mirror/s);
  });

  it('degrades explicitly for missing credentials, invalid Stage and foreign audit actors', async () => {
    const f = fixture();
    f.audit('done', 'external-agent');
    f.setStage(null);
    const skipped = await integrationHooks(f.board, 42, {});
    expect(skipped).toMatchObject({ project: 'skipped', teams: 'skipped' });
    expect(skipped.warnings.join(' ')).toMatch(/PRONOIA_PROJECT_TOKEN/);
    f.setField('ProjectV2Field');
    const badField = await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    expect(badField.project).toBe('degraded');
    expect(badField.warnings.join(' ')).toMatch(/single.select/i);
    f.setField('ProjectV2SingleSelectField');
    await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });
    expect(f.stage()).toBe('To Do');
    expect((await reconcileProject(f.board, '')).warnings.join(' ')).toMatch(
      /PRONOIA_PROJECT_TOKEN/,
    );
  });

  it('refuses malformed single-select JSON before replacing any existing options', async () => {
    const f = fixture();
    f.omitFieldOptions();
    const report = await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    });

    expect(report.project).toBe('degraded');
    expect(f.writes).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/Invalid.*response/);
  });

  it('does not retry non-idempotent Stage creation after a lost acknowledgement', async () => {
    const f = fixture();
    f.setField('missing');
    f.loseFieldCreationAck();
    const options = {
      projectToken: 'synthetic-project-token',
      fetch: f.fetcher,
    };
    expect((await integrationHooks(f.board, 42, options)).project).toBe(
      'degraded',
    );
    expect(
      f.writes.filter((write) => write.query.includes('createProjectV2Field')),
    ).toHaveLength(1);
    expect((await integrationHooks(f.board, 42, options)).project).toBe(
      'mirrored',
    );
  });
});

describe('Teams review notifications', () => {
  it('sends only a GitHub OpenUrl card and trusts only bot-owned audit receipts', async () => {
    const f = fixture();
    f.audit('validate');
    const auditComment = f.comments[0];
    if (!auditComment) throw new Error('Missing synthetic audit.');
    f.comments.push({
      ...auditComment,
      id: 20,
      body: marker('notification-receipt', {
        schema_version: 1,
        channel: 'teams',
        audit_comment_id: 10,
      }),
      user: { login: 'external-agent', type: 'User' },
    });
    const options = { teamsWebhook: webhook, fetch: f.fetcher };
    expect((await integrationHooks(f.board, 42, options)).teams).toBe('sent');
    const card = z
      .object({
        type: z.literal('message'),
        attachments: z.array(
          z.object({
            contentType: z.literal('application/vnd.microsoft.card.adaptive'),
            content: z.object({
              body: z.array(
                z.object({ type: z.literal('TextBlock'), text: z.string() }),
              ),
              actions: z.array(
                z.object({
                  type: z.literal('Action.OpenUrl'),
                  title: z.string(),
                  url: z.url(),
                }),
              ),
            }),
          }),
        ),
      })
      .parse(f.cards[0]);
    expect(card.attachments[0]?.content.actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'Review on GitHub',
        url: f.issue.html_url,
      },
    ]);
    expect(JSON.stringify(card)).toMatch(/different, uninvolved human/);
    expect(JSON.stringify(card)).not.toContain('example.invalid');
    expect(f.comments.at(-1)?.user?.login).toBe('github-actions[bot]');
    expect((await integrationHooks(f.board, 42, options)).teams).toBe(
      'unchanged',
    );
    expect(f.cards).toHaveLength(1);
  });

  it.each(['blocked', 'done'] as const)(
    'notifies an audited %s transition without decision controls',
    async (status) => {
      const f = fixture();
      f.audit(status);
      expect(
        (
          await integrationHooks(f.board, 42, {
            teamsWebhook: webhook,
            fetch: f.fetcher,
          })
        ).teams,
      ).toBe('sent');
      expect(JSON.stringify(f.cards)).not.toMatch(
        /Action.Submit|Action.Http|\/approve/,
      );
      expect(JSON.stringify(f.cards)).toMatch(/human|Human/);
    },
  );

  it('does not notify forged audits or non-notifiable transitions', async () => {
    const f = fixture();
    f.audit('done', 'external-agent');
    expect(
      (
        await integrationHooks(f.board, 42, {
          teamsWebhook: webhook,
          fetch: f.fetcher,
        })
      ).teams,
    ).toBe('skipped');
    f.audit('in-progress');
    expect(
      (
        await integrationHooks(f.board, 42, {
          teamsWebhook: webhook,
          fetch: f.fetcher,
        })
      ).teams,
    ).toBe('skipped');
    expect(f.cards).toEqual([]);
  });

  it.each([
    'http://synthetic.aa.environment.api.powerplatform.com/workflows/x',
    'https://example.invalid/workflows/x?sig=synthetic-secret',
    'https://synthetic.api.powerplatform.com.example.invalid/workflows/x',
    'https://synthetic-secret@synthetic.api.powerplatform.com/workflows/x',
    'https://synthetic.api.powerplatform.com/arbitrary',
  ])(
    'refuses unsafe webhook destinations without exposing credentials',
    async (teamsWebhook) => {
      const f = fixture();
      f.audit('validate');
      const report = await integrationHooks(f.board, 42, {
        teamsWebhook,
        fetch: f.fetcher,
      });
      expect(report.teams).toBe('degraded');
      expect(report.warnings.join(' ')).not.toContain('synthetic-secret');
      expect(f.cards).toEqual([]);
    },
  );

  it.each([403, 404])(
    'reports HTTP %i and creates no success receipt',
    async (status) => {
      const f = fixture();
      f.audit('validate');
      f.setWebhookStatus(status);
      const report = await integrationHooks(f.board, 42, {
        teamsWebhook: webhook,
        fetch: f.fetcher,
      });
      expect(report.teams).toBe('degraded');
      expect(report.warnings.join(' ')).toContain(String(status));
      expect(f.comments).toHaveLength(1);
    },
  );

  it('reports at-least-once risk when the webhook was accepted but receipt writing fails', async () => {
    const f = fixture();
    f.audit('validate');
    f.failReceipt();
    const report = await integrationHooks(f.board, 42, {
      teamsWebhook: webhook,
      fetch: f.fetcher,
    });
    expect(report.teams).toBe('degraded');
    expect(report.warnings.join(' ')).toMatch(/receipt.*duplicate/i);
  });

  it('refuses human/configured automation tokens before any mutation or webhook', async () => {
    const f = fixture();
    f.audit('validate');
    f.setLogin('external-agent');
    const report = await integrationHooks(f.board, 42, {
      projectToken: 'synthetic-project-token',
      teamsWebhook: webhook,
      fetch: f.fetcher,
    });
    expect(report).toMatchObject({ project: 'degraded', teams: 'degraded' });
    expect(report.warnings.join(' ')).toMatch(/github-actions\[bot\]/);
    expect(f.writes).toEqual([]);
    expect(f.cards).toEqual([]);
    expect(
      (
        await reconcileProject(f.board, 'synthetic-project-token', {
          fetch: f.fetcher,
        })
      ).warnings.join(' '),
    ).toMatch(/github-actions\[bot\]/);
  });

  it('bounds network failure retries and redacts thrown transport errors', async () => {
    const f = fixture();
    f.audit('validate');
    let attempts = 0;
    const failing: typeof fetch = async () => {
      attempts += 1;
      throw new Error(webhook);
    };
    const report = await integrationHooks(f.board, 42, {
      teamsWebhook: webhook,
      fetch: failing,
    });
    expect(report.teams).toBe('degraded');
    expect(attempts).toBe(2);
    expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  });
});
