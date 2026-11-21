import { Octokit } from 'octokit';
import { beforeAll, expect, it, vi } from 'vitest';
import { Board } from './github.js';
import { configSchema } from './config.js';
import { assessmentRows, marker, metaSchema } from './assessment.js';
import {
  FoundryService,
  createFoundryClient,
  foundryConfig,
} from './ai/foundry.js';
import { readAudit } from './workflow/engine.js';
import { requestManualAi } from './ai/commands.js';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function fixture() {
  const issue = {
    number: 1,
    title: 'Synthetic MFA check',
    body: '',
    labels: ['pronoia', 'status:todo'],
    assignees: [] as { login: string }[],
    state: 'open',
    html_url: 'https://github.com/Contoso/demo/issues/1',
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  };
  const comments: {
    id: number;
    body: string;
    user: { login: string; type: string };
    author_association: string;
    created_at: string;
    html_url: string;
  }[] = [];
  const labels = new Set<string>();
  const files = new Map<string, Buffer>();
  const prs = new Map<
    number,
    { user: { login: string }; merged_at: string | null }
  >();
  const milestones: { number: number; title: string }[] = [];
  let evidenceBranch = false;
  const issues = [issue];
  const posted: string[] = [];
  const positiveReactions = new Set<number>();
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    let data: unknown;
    if (method === 'GET' && path.endsWith('/issues/1/comments'))
      data = comments;
    else if (method === 'GET' && path.endsWith('/issues/1/timeline')) data = [];
    else if (method === 'GET' && path.endsWith('/issues/1')) data = issue;
    else if (method === 'GET' && /\/issues\/\d+$/.test(path)) {
      const number = Number(path.split('/').at(-1));
      const pr = prs.get(number);
      if (!pr) throw new Error('Unknown fixture reference');
      data = {
        ...issue,
        number,
        html_url: `https://github.com/Contoso/demo/pull/${number}`,
        pull_request: {
          url: `https://api.github.com/repos/Contoso/demo/pulls/${number}`,
        },
      };
    } else if (method === 'GET' && path.endsWith('/issues')) data = issues;
    else if (method === 'GET' && path.endsWith('/labels'))
      data = [...labels].map((name) => ({ name }));
    else if (method === 'GET' && path.endsWith('/milestones'))
      data = milestones;
    else if (method === 'GET' && path === '/repos/Contoso/demo')
      data = { private: false, default_branch: 'main' };
    else if (method === 'GET' && path.includes('/pulls/'))
      data = prs.get(Number(path.split('/').at(-1)));
    else if (
      method === 'GET' &&
      path.endsWith('/git/trees/evidence') &&
      evidenceBranch
    )
      data = {
        truncated: false,
        tree: [...files.keys()].map((path) => ({
          type: 'blob',
          path,
          sha: 'c'.repeat(40),
        })),
      };
    else if (
      method === 'GET' &&
      path.endsWith('/git/ref/heads/evidence') &&
      evidenceBranch
    )
      data = { ref: 'refs/heads/evidence', object: { sha: 'b'.repeat(40) } };
    else if (
      method === 'GET' &&
      path.includes('/contents/') &&
      files.has(decodeURIComponent(path.split('/contents/')[1] ?? ''))
    ) {
      const file = files.get(
        decodeURIComponent(path.split('/contents/')[1] ?? ''),
      );
      if (!file) throw new Error('Missing fixture file');
      data = {
        type: 'file',
        sha: 'c'.repeat(40),
        encoding: 'base64',
        content: file.toString('base64'),
      };
    } else if (
      method === 'GET' &&
      (path.includes('/git/') || path.includes('/contents/'))
    ) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    } else if (method === 'GET' && path === '/user')
      data = { login: 'human', type: 'User' };
    else if (method === 'PUT' && path.endsWith('/issues/1/labels')) {
      const value = body as { labels: string[] };
      issue.labels = value.labels;
      writes += 1;
      data = value.labels.map((name) => ({ name }));
    } else if (method === 'POST' && path.endsWith('/issues/1/labels')) {
      const value = body as { labels: string[] };
      issue.labels = [...new Set([...issue.labels, ...value.labels])];
      data = issue.labels.map((name) => ({ name }));
    } else if (method === 'POST' && path.endsWith('/issues/1/assignees')) {
      const value = body as { assignees: string[] };
      issue.assignees = [
        ...issue.assignees,
        ...value.assignees.map((login) => ({ login })),
      ];
      data = issue;
    } else if (method === 'PATCH' && path.endsWith('/issues/1')) {
      Object.assign(issue, body);
      const update = body as { assignees?: string[] };
      if (update.assignees)
        issue.assignees = update.assignees.map((login) => ({ login }));
      writes += 1;
      data = issue;
    } else if (method === 'POST' && path.endsWith('/labels')) {
      const value = body as { name: string };
      labels.add(value.name);
      data = value;
    } else if (method === 'POST' && path.endsWith('/issues/1/comments')) {
      const value = body as { body: string };
      posted.push(value.body);
      const comment = {
        id: comments.length + 100,
        body: value.body,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        author_association: 'MEMBER',
        created_at: '2026-11-20T12:00:00Z',
        html_url: 'https://github.com/Contoso/demo/issues/1#comment',
      };
      comments.push(comment);
      data = comment;
    } else if (method === 'POST' && path.endsWith('/issues')) {
      const value = body as {
        title: string;
        body: string;
        labels: string[];
        milestone?: number;
      };
      const milestone =
        value.milestone === undefined
          ? null
          : milestones.find((entry) => entry.number === value.milestone);
      if (value.milestone !== undefined && !milestone)
        throw new Error('Unknown fixture milestone');
      const created = {
        ...issue,
        ...value,
        milestone,
        number: issues.length + 1,
      };
      issues.push(created);
      writes += 1;
      data = created;
    } else if (method === 'POST' && path.endsWith('/milestones')) {
      const value = body as { title: string };
      const milestone = { number: milestones.length + 1, title: value.title };
      milestones.push(milestone);
      data = milestone;
    } else if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(path)) {
      const comment = comments.find(
        (entry) => entry.id === Number(path.split('/').at(-1)),
      );
      if (!comment) throw new Error('Unknown fixture comment');
      comment.body = (body as { body: string }).body;
      data = comment;
    } else if (method === 'POST' && path.endsWith('/reactions')) {
      const id = Number(/\/comments\/(\d+)\/reactions$/.exec(path)?.[1]);
      if ((body as { content: string }).content === '+1')
        positiveReactions.add(id);
      data = { id: 1 };
    } else if (method === 'POST' && path.endsWith('/git/trees'))
      data = { sha: 'a'.repeat(40) };
    else if (method === 'POST' && path.endsWith('/git/commits'))
      data = { sha: 'b'.repeat(40) };
    else if (method === 'POST' && path.endsWith('/git/refs')) {
      evidenceBranch = true;
      data = { ref: 'refs/heads/evidence', object: { sha: 'b'.repeat(40) } };
    } else if (method === 'PUT' && path.includes('/contents/')) {
      const name = decodeURIComponent(path.split('/contents/')[1] ?? '');
      const value = body as { content: string; sha?: string };
      if (!name) throw new Error('Missing fixture path');
      if (files.has(name) && !value.sha)
        return new Response(
          JSON.stringify({ message: 'sha is required for an existing path' }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        );
      files.set(name, Buffer.from(value.content, 'base64'));
      writes += 1;
      data = {
        content: { path: name, sha: 'c'.repeat(40) },
        commit: { sha: 'd'.repeat(40) },
      };
    } else throw new Error(`Unhandled fixture request: ${method} ${path}`);
    return new Response(JSON.stringify(data), {
      status: method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const config = configSchema.parse({ board_repo: 'Contoso/demo' });
  const client = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(client, config);
  function command(body: string, login = 'requester', agent = '') {
    const id = comments.length + 1;
    comments.push({
      id,
      body: body + agent,
      user: { login, type: 'User' },
      author_association: 'COLLABORATOR',
      created_at: '2026-11-20T12:00:00Z',
      html_url: 'https://github.com/Contoso/demo/issues/1#command',
    });
    return id;
  }
  return {
    board,
    issue,
    comments,
    labels,
    issues,
    posted,
    command,
    files,
    prs,
    milestones,
    positiveReactions,
    writes: () => writes,
  };
}

it('processes queued commands once and repairs interrupted status writes from trusted audit', async () => {
  const f = fixture();
  f.command('/start');
  f.command('/validate verified in synthetic test');
  await f.board.applyCommands(1);
  expect(f.issue.labels).toContain('status:validate');
  expect(f.issue.assignees).toEqual([{ login: 'requester' }]);
  const count = f.posted.length;
  await f.board.applyCommands(1);
  expect(f.posted).toHaveLength(count);
  f.issue.labels = ['pronoia', 'status:done'];
  f.issue.state = 'closed';
  await f.board.guard(1);
  expect(f.issue.labels).toContain('status:validate');
  expect(f.issue.state).toBe('open');
});

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const reviewed = {
  note: 'Synthetic test image; reviewed.',
  source: 'test',
  reviewed: true,
  synthetic: true,
};

it('publishes reviewed synthetic PNGs on an orphan evidence branch and audits the hash', async () => {
  const f = fixture();
  await expect(
    f.board.addEvidence(1, pixel, { ...reviewed, reviewed: false }),
  ).rejects.toThrow(/review/i);
  await expect(
    f.board.addEvidence(1, pixel, { ...reviewed, synthetic: false }),
  ).rejects.toThrow(/synthetic/i);
  const evidence = await f.board.addEvidence(1, pixel, reviewed);
  expect(f.files.get(evidence.file)).toEqual(pixel);
  expect(f.posted.join('\n')).toContain(evidence.sha256);
  expect(await f.board.evidenceFiles(1)).toHaveLength(1);
  expect(await f.board.evidenceFiles(2)).toHaveLength(0);
});

it('reuses an identical screenshot captured in the same second without a failed second upload', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  try {
    const f = fixture();
    const first = await f.board.addEvidence(1, pixel, reviewed);
    const second = await f.board.addEvidence(1, pixel, reviewed);
    expect(second.file).toBe(first.file);
    expect(f.files.size).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves the original capture timestamp and recovers evidence retries without duplicate comments', async () => {
  const f = fixture();
  const authenticated = await f.board.api.rest.users.getAuthenticated();
  vi.spyOn(f.board.api.rest.users, 'getAuthenticated').mockResolvedValue({
    ...authenticated,
    data: { ...authenticated.data, login: 'github-actions[bot]', type: 'Bot' },
  });
  const capturedAt = '2026-11-20T12:00:00Z';
  const details = {
    ...reviewed,
    capturedAt,
    session: 'synthetic-session',
    step: 'Confirm MFA challenge',
  };
  const first = await f.board.addEvidence(1, pixel, details);
  const second = await f.board.addEvidence(1, pixel, details);
  expect(first.captured_at).toBe(capturedAt);
  expect(second.file).toBe(first.file);
  expect(
    f.posted.filter((body) => body.includes('pronoia:evidence')),
  ).toHaveLength(1);
  await expect(
    f.board.addEvidence(1, pixel, {
      ...details,
      capturedAt: 'not-a-timestamp',
    }),
  ).rejects.toThrow();
});

it('checks linked PR authors and closes only after a different human approves with evidence', async () => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  await f.board.addEvidence(1, pixel, reviewed);
  f.issue.body += '\n\n## Linked PRs\nhttps://github.com/Contoso/demo/pull/9';
  f.prs.set(9, { user: { login: 'fixer' }, merged_at: '2026-11-20T12:00:00Z' });
  f.command('/approve', 'fixer');
  f.command(
    '/approve\nValidated-by: Fictional Contoso validator',
    'independent',
  );
  const result = await f.board.applyCommands(1);
  expect(result).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.state).toBe('closed');
  expect(f.issue.labels).toContain('status:done');
  expect(f.posted.join('\n')).toContain('Four-eyes');
});

it('refuses agent human-only comments before posting and stamps allowed commands', async () => {
  const f = fixture();
  await expect(f.board.comment(1, '/approve', 'scout')).rejects.toThrow(
    /Agents/i,
  );
  expect(f.posted).toHaveLength(0);
  await f.board.comment(1, '/validate verified', 'scout');
  expect(f.posted[0]).toContain('pronoia:agent');
});

it('refuses To Do approval, missing reasons and agent-stamped human-only commands with an explanation', async () => {
  const f = fixture();
  f.command('/approve');
  f.command('/reject');
  f.command(
    '/approve',
    'reviewer',
    '\n<!-- pronoia:agent {"agent":"scout"} -->',
  );
  await f.board.applyCommands(1);
  expect(f.issue.labels).toContain('status:todo');
  expect(
    f.posted.filter((body) => body.includes('pronoia:command-result')),
  ).toHaveLength(3);
  expect(f.posted.join('\n')).toMatch(/allowed|human-only|reason/i);
  expect(f.issue.state).toBe('open');
  const count = f.posted.length;
  await f.board.applyCommands(1);
  expect(f.posted).toHaveLength(count);
});

it('imports idempotently and performs no writes on dry-run', async () => {
  const f = fixture();
  const rows = assessmentRows(
    'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nS1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,',
  );
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', {
      dryRun: true,
      synthetic: true,
    }),
  ).toMatchObject({ created: 0, planned: 1 });
  expect(f.writes()).toBe(0);
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', { synthetic: true }),
  ).toMatchObject({ created: 1 });
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', { synthetic: true }),
  ).toMatchObject({ created: 0 });
  expect(f.milestones).toEqual([{ number: 1, title: 'Synthetic demo' }]);
});

it('rejects invalid evidence without poisoning the following command queue', async () => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  const evidence = await f.board.addEvidence(1, pixel, reviewed);
  f.files.set(evidence.file, Buffer.from('tampered, not a PNG'));
  f.command('/approve', 'independent');
  f.command('/reject evidence needs recapture', 'independent');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.state).toBe('open');
  expect(f.issue.labels).toContain('status:in-progress');
});

it('marks agent-created synthetic assessments and rejects malformed identities before writes', async () => {
  const rows = assessmentRows(
    'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nS1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,',
  );
  const f = fixture();
  await f.board.importAssessment(
    rows,
    'Synthetic agent import',
    Object.assign({ synthetic: true }, { agent: 'PronoiaMCP' }),
  );
  expect(f.issues.at(-1)?.body).toContain(
    marker('agent', { agent: 'PronoiaMCP' }),
  );
  const refused = fixture();
  await expect(
    refused.board.importAssessment(
      rows,
      'Synthetic agent import',
      Object.assign({ synthetic: true }, { agent: 'not a safe identity' }),
    ),
  ).rejects.toThrow();
  expect(refused.writes()).toBe(0);
});

it.each([
  '#9',
  'GH-9',
  'Contoso/demo#9',
  'https://github.com/Contoso/demo/issues/9',
])('enforces four-eyes for the GitHub reference form %s', async (reference) => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  await f.board.addEvidence(1, pixel, reviewed);
  f.issue.body += `\n\n## Linked PRs\nRefs ${reference}`;
  f.prs.set(9, {
    user: { login: 'fixer' },
    merged_at: '2026-11-20T12:00:00Z',
  });
  f.command('/approve', 'fixer');
  expect(await f.board.applyCommands(1)).toEqual({
    accepted: 0,
    rejected: 1,
  });
  expect(f.issue.state).toBe('open');
});

it.each(['/assign @new-worker', '/severity high'])(
  'recovers the journaled metadata after a failed write: %s',
  async (body) => {
    const f = fixture();
    f.issue.labels.push('severity:medium');
    f.command(body);
    vi.spyOn(f.board.api.rest.issues, 'setLabels').mockRejectedValueOnce(
      new Error('transient write failure'),
    );
    await expect(f.board.applyCommands(1)).rejects.toThrow(
      'transient write failure',
    );
    await f.board.applyCommands(1);
    if (body.startsWith('/assign'))
      expect(f.issue.assignees).toEqual([{ login: 'new-worker' }]);
    else expect(f.issue.labels).toContain('severity:high');
  },
);

it('recovers a missing success reaction after an interrupted accepted command', async () => {
  const f = fixture();
  const id = f.command('/start');
  vi.spyOn(
    f.board.api.rest.reactions,
    'createForIssueComment',
  ).mockRejectedValueOnce(new Error('transient reaction failure'));
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'transient reaction failure',
  );
  await f.board.applyCommands(1);
  expect(f.positiveReactions.has(id)).toBe(true);
});

it('rejects unsendable serialized audits and continues with later commands', async () => {
  const f = fixture();
  f.command(`/block ${'<'.repeat(10000)}`);
  f.command('/start');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.labels).toContain('status:in-progress');
});

it('prevents human-only agent commands even when the marker is already in the body', async () => {
  const f = fixture();
  await expect(
    f.board.comment(1, '/approve\n<!-- pronoia:agent {"agent":"scout"} -->'),
  ).rejects.toThrow(/agent/i);
  expect(f.posted).toHaveLength(0);
});

it('does not publish unreviewed real data to a public repository', async () => {
  const f = fixture();
  const rows = assessmentRows(
    'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nS1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,',
  );
  await expect(
    f.board.importAssessment(rows, 'Engagement', {}),
  ).rejects.toThrow(/synthetic|public/i);
  expect(f.writes()).toBe(0);
});

it('updates only the validation section without erasing later human-authored sections', async () => {
  const f = fixture();
  f.issue.body =
    '## Test\nSynthetic test.\n\n## Validation trail\nOld summary.\n\n## Extra details\nPreserve this note.';
  f.command('/start');
  await f.board.applyCommands(1);
  expect(f.issue.body).toContain('## Extra details\nPreserve this note.');
});

it('processes internal restricted bot commands with NONE association, never external bot approvals', async () => {
  const f = fixture();
  const id = f.command('/start', 'github-actions[bot]');
  const internal = f.comments.find((comment) => comment.id === id);
  if (!internal) throw new Error('Missing internal fixture');
  internal.author_association = 'NONE';
  internal.user.type = 'Bot';
  f.command('/approve', 'external[bot]');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.labels).toContain('status:in-progress');
});

it.each(['open', 'dismissed', 'fixed'] as const)(
  'bypasses automated evidence only with a real merged PR and a live fixed alert (%s)',
  async (alertState) => {
    const f = fixture();
    const target = new Octokit({
      retry: { enabled: false },
      throttle: { enabled: false },
      request: {
        fetch: async () =>
          new Response(
            JSON.stringify({
              number: 2,
              state: alertState,
              created_at: '2026-11-01T12:00:00Z',
              dependency: {
                package: { name: 'lodash', ecosystem: 'npm' },
                manifest_path: 'samples/package-lock.json',
              },
              security_advisory: { ghsa_id: 'GHSA-35jh-r3h4-6jhm' },
              security_vulnerability: {
                vulnerable_version_range: '<4.17.21',
                first_patched_version: { identifier: '4.17.21' },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    });
    f.board.integrations.targetApi = target;
    f.issue.body =
      marker(
        'meta',
        metaSchema.parse({
          dedupe_key: 'dependabot/contoso/demo/2',
          source: 'dependabot',
          assessment: 'Synthetic',
          test_id: '2',
          synthetic: true,
          alert_refs: [
            { repo: 'Contoso/demo', source: 'dependabot', number: 2 },
          ],
        }),
      ) +
      '\n\n<!-- claimed-fixed-proof -->\nhttps://github.com/Contoso/demo/pull/9';
    f.prs.set(9, {
      user: { login: 'fixer' },
      merged_at: '2026-11-20T12:00:00Z',
    });
    f.command('/validate synthetic test', 'worker');
    await f.board.applyCommands(1);
    f.command('/approve', 'independent');
    const result = await f.board.applyCommands(1);
    expect(result.accepted).toBe(alertState === 'fixed' ? 1 : 0);
    expect(f.issue.state).toBe(alertState === 'fixed' ? 'closed' : 'open');
  },
);

it('does not use a fixed-alert marker or source status without a real merged PR as approval proof', async () => {
  const f = fixture();
  f.issue.body =
    marker(
      'meta',
      metaSchema.parse({
        dedupe_key: 'sarif/contoso/demo/demo',
        source: 'sarif',
        assessment: 'Synthetic',
        test_id: 'demo',
        synthetic: true,
      }),
    ) + '\n<!-- pronoia:internal-command {"alert_fixed_observed":true} -->';
  f.command('/validate tested', 'worker');
  f.command('/approve', 'independent');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.state).toBe('open');
});

it('rejects a malformed PR response instead of treating a missing merged_at field as a merge', async () => {
  const f = fixture();
  f.issue.body =
    marker(
      'meta',
      metaSchema.parse({
        dedupe_key: 'dependabot/contoso/demo/2',
        source: 'dependabot',
        assessment: 'Synthetic',
        test_id: '2',
        synthetic: true,
        alert_refs: [{ repo: 'Contoso/demo', source: 'dependabot', number: 2 }],
      }),
    ) + '\nhttps://github.com/Contoso/demo/pull/9';
  const fixed = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
    request: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            number: 2,
            state: 'fixed',
            created_at: '2026-11-01T12:00:00Z',
            dependency: {
              package: { name: 'lodash', ecosystem: 'npm' },
              manifest_path: 'samples/package-lock.json',
            },
            security_advisory: { ghsa_id: 'GHSA-35jh-r3h4-6jhm' },
            security_vulnerability: {
              vulnerable_version_range: '<4.17.21',
              first_patched_version: { identifier: '4.17.21' },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    },
  });
  f.board.integrations.targetApi = fixed;
  vi.spyOn(f.board.api.rest.pulls, 'get').mockResolvedValue({
    data: { user: { login: 'fixer' } },
  } as Awaited<ReturnType<typeof f.board.api.rest.pulls.get>>);
  f.command('/validate tested', 'worker');
  await f.board.applyCommands(1);
  f.command('/approve', 'independent');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 0, rejected: 1 });
  expect(f.issue.state).toBe('open');
});

it('does not apply statuses when the journal was not written by the authoritative Actions identity', async () => {
  const f = fixture();
  f.command('/start');
  const post = f.board.comment.bind(f.board);
  vi.spyOn(f.board, 'comment').mockImplementationOnce(async (...args) => ({
    ...(await post(...args)),
    user: { login: 'human', type: 'User' },
  }));
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    /authoritative|audit writer/i,
  );
  expect(f.issue.labels).toContain('status:todo');
});

function foundryFixture() {
  const config = foundryConfig({
    AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.openai.azure.com',
    AZURE_AUTH_MODE: 'key',
    AZURE_FOUNDRY_API_KEY: 'test-only-noncredential',
    FOUNDRY_CHAT_DEPLOYMENT: 'demo',
  });
  if (!config.ok) throw new Error('Invalid Foundry fixture');
  const service = new FoundryService(
    createFoundryClient(config.value),
    config.value,
  );
  vi.spyOn(service, 'call').mockResolvedValue({
    ok: true,
    value: {
      summary: 'Synthetic AI proposal.',
      priority: 'p2',
      reason: 'Review only.',
      remediation: ['Add tests.'],
      references: [],
      confidence: 0.8,
    },
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, calls: 1 },
    warnings: [],
  });
  return service;
}

beforeAll(() => {
  foundryFixture();
}, 30000);

it.each(['triage', 'remediate', 'test-plan', 'summarize'])(
  'processes human /ai %s as a labelled proposal with journal/result IDs, not a status change',
  async (mode) => {
    const f = fixture();
    const service = foundryFixture();
    f.board.integrations.foundry = service;
    const id = f.command(`/ai ${mode}`);
    expect(await f.board.applyCommands(1)).toEqual({
      accepted: 1,
      rejected: 0,
    });
    expect(f.issue.labels).toContain('status:todo');
    expect(f.issue.labels).toContain('ai:proposal');
    const audit = f.comments
      .flatMap((comment) => {
        const audit = readAudit(comment.body, comment.user.login);
        return audit ? [audit] : [];
      })
      .at(-1);
    expect(audit).toMatchObject({
      comment_id: id,
      audit_comment_id: expect.any(Number),
      effect_comment_id: expect.any(Number),
    });
    expect(f.posted.join('\n')).toContain('AI proposal');
    expect(service.call).toHaveBeenCalledTimes(1);
  },
);

it('recovers an interrupted AI proposal without generating or posting it twice', async () => {
  const f = fixture();
  const service = foundryFixture();
  f.board.integrations.foundry = service;
  f.command('/ai triage');
  vi.spyOn(f.board.api.rest.issues, 'addLabels').mockRejectedValueOnce(
    new Error('transient label failure'),
  );
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'transient label failure',
  );
  await f.board.applyCommands(1);
  expect(service.call).toHaveBeenCalledTimes(1);
  expect(
    f.posted.filter((body) => body.includes('pronoia:ai-proposal')),
  ).toHaveLength(1);
  expect(f.issue.labels).toContain('ai:proposal');
});

it('never lets an agent invoke /ai or /copilot, even with a human token marker', async () => {
  const f = fixture();
  const service = foundryFixture();
  f.board.integrations.foundry = service;
  f.command(
    '/ai triage',
    'reviewer',
    '\n<!-- pronoia:agent {"agent":"scout"} -->',
  );
  f.command(
    '/copilot',
    'reviewer',
    '\n<!-- pronoia:agent {"agent":"scout"} -->',
  );
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 0, rejected: 2 });
  expect(service.call).not.toHaveBeenCalled();
});

it('assigns only the documented Copilot bot with constrained instructions and preserves it on retry', async () => {
  const f = fixture();
  f.board.integrations.agentApi = f.board.api;
  vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
    repository: {
      suggestedActors: {
        nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
    },
  });
  const assignment = vi.spyOn(f.board.api.rest.issues, 'addAssignees');
  f.command('/start', 'worker');
  await f.board.applyCommands(1);
  f.command('/copilot', 'requester');
  vi.spyOn(f.board.api.rest.issues, 'updateComment').mockRejectedValueOnce(
    new Error('transient audit edit failure'),
  );
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'transient audit edit failure',
  );
  expect(f.issue.assignees).toContainEqual({ login: 'copilot-swe-agent[bot]' });
  await f.board.applyCommands(1);
  expect(assignment).toHaveBeenCalledTimes(1);
  expect(assignment).toHaveBeenCalledWith(
    expect.objectContaining({
      assignees: ['copilot-swe-agent[bot]'],
      agent_assignment: {
        target_repo: 'Contoso/demo',
        base_branch: 'main',
        custom_instructions:
          'Refs #1, never Fixes/Closes. Add tests. Do not modify workflows.',
      },
    }),
  );
  expect(f.issue.assignees).toEqual([
    { login: 'worker' },
    { login: 'copilot-swe-agent[bot]' },
  ]);
  expect(f.issue.labels).toContain('status:in-progress');
});

it('rejects unsupported Copilot assignment clearly without losing later commands', async () => {
  const f = fixture();
  f.board.integrations.agentApi = f.board.api;
  vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
    repository: { suggestedActors: { nodes: [] } },
  });
  f.command('/copilot');
  f.command('/start');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.posted.join('\n')).toMatch(/Copilot.*unsupported|not enabled/i);
});

it.each([401, 403, 404, 422])(
  'completes a terminal Copilot API failure (%s) without poisoning the next command or retry',
  async (status) => {
    const f = fixture();
    f.board.integrations.agentApi = f.board.api;
    vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
      repository: {
        suggestedActors: {
          nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
        },
      },
    });
    const assign = vi
      .spyOn(f.board.api.rest.issues, 'addAssignees')
      .mockRejectedValueOnce(
        Object.assign(new Error('private upstream error'), { status }),
      );
    f.command('/copilot');
    f.command('/start', 'worker');
    expect(await f.board.applyCommands(1)).toEqual({
      accepted: 1,
      rejected: 1,
    });
    expect(f.issue.labels).toContain('status:in-progress');
    expect(f.issue.assignees).toEqual([{ login: 'worker' }]);
    expect(f.posted.join('\n')).not.toContain('private upstream error');
    expect(f.posted.join('\n')).toMatch(/Copilot.*unavailable|permission/i);
    await f.board.applyCommands(1);
    expect(assign).toHaveBeenCalledTimes(1);
  },
);

it('recovers a terminal Copilot receipt even if recording its failure was interrupted', async () => {
  const f = fixture();
  f.board.integrations.agentApi = f.board.api;
  vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
    repository: {
      suggestedActors: {
        nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
    },
  });
  const assign = vi
    .spyOn(f.board.api.rest.issues, 'addAssignees')
    .mockRejectedValueOnce(
      Object.assign(new Error('private upstream error'), { status: 403 }),
    );
  f.command('/copilot');
  vi.spyOn(f.board.api.rest.issues, 'updateComment').mockRejectedValueOnce(
    new Error('interrupted journal edit'),
  );
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'interrupted journal edit',
  );
  await f.board.applyCommands(1);
  await f.board.applyCommands(1);
  expect(assign).toHaveBeenCalledTimes(1);
  expect(f.issue.labels).toContain('status:todo');
});

it('recovers a confirmed Copilot assignment without needing its removed user token again', async () => {
  const f = fixture();
  f.board.integrations.agentApi = f.board.api;
  vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
    repository: {
      suggestedActors: {
        nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
    },
  });
  const assign = vi.spyOn(f.board.api.rest.issues, 'addAssignees');
  f.command('/copilot');
  vi.spyOn(f.board.api.rest.issues, 'updateComment').mockRejectedValueOnce(
    new Error('interrupted journal edit'),
  );
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'interrupted journal edit',
  );
  f.board.integrations.agentApi = undefined;
  await f.board.applyCommands(1);
  expect(assign).toHaveBeenCalledTimes(1);
  expect(f.issue.assignees).toContainEqual({ login: 'copilot-swe-agent[bot]' });
});

it('does not leave recovery stuck when Copilot becomes unsupported before a task was assigned', async () => {
  const f = fixture();
  f.board.integrations.agentApi = f.board.api;
  const actors = vi.spyOn(f.board.api, 'graphql').mockResolvedValue({
    repository: {
      suggestedActors: {
        nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
    },
  });
  vi.spyOn(f.board.api.rest.issues, 'addAssignees').mockRejectedValueOnce(
    new Error('transient request failure'),
  );
  f.command('/copilot');
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'transient request failure',
  );
  actors.mockResolvedValue({ repository: { suggestedActors: { nodes: [] } } });
  f.command('/start', 'worker');
  await expect(f.board.applyCommands(1)).resolves.toMatchObject({
    accepted: 1,
  });
  expect(f.issue.assignees).toEqual([{ login: 'worker' }]);
});

it('gates manual AI on the actual Actions event and collaborator API, never an input actor', async () => {
  const f = fixture();
  const service = foundryFixture();
  const eventFile = resolve(`.m2-event-${randomUUID()}.json`);
  vi.spyOn(
    f.board.api.rest.repos,
    'getCollaboratorPermissionLevel',
  ).mockResolvedValue({ data: { permission: 'write' } } as Awaited<
    ReturnType<typeof f.board.api.rest.repos.getCollaboratorPermissionLevel>
  >);
  vi.spyOn(f.board.api.rest.users, 'getByUsername').mockResolvedValue({
    data: { login: 'requester', type: 'User' },
  } as Awaited<ReturnType<typeof f.board.api.rest.users.getByUsername>>);
  try {
    writeFileSync(
      eventFile,
      JSON.stringify({ sender: { login: 'requester' } }),
    );
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_EVENT_PATH', eventFile);
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    const result = await requestManualAi(f.board, service, 1, 'triage');
    expect(result).toMatchObject({
      request_comment_id: expect.any(Number),
      proposal_comment_id: expect.any(Number),
    });
    expect(f.issue.labels).toContain('status:todo');
    expect(
      f.comments.filter((comment) => comment.body.startsWith('/')),
    ).toHaveLength(0);
    await requestManualAi(f.board, service, 1, 'triage');
    expect(service.call).toHaveBeenCalledTimes(1);
    vi.mocked(
      f.board.api.rest.repos.getCollaboratorPermissionLevel,
    ).mockResolvedValue({ data: { permission: 'read' } } as Awaited<
      ReturnType<typeof f.board.api.rest.repos.getCollaboratorPermissionLevel>
    >);
    await expect(
      requestManualAi(f.board, service, 1, 'triage'),
    ).rejects.toThrow(/collaborator|human/i);
  } finally {
    vi.unstubAllEnvs();
    rmSync(eventFile, { force: true });
  }
});

it('recovers a completed trusted AI proposal with missing Foundry configuration and drains later commands', async () => {
  const f = fixture();
  const foundry = foundryFixture();
  f.board.integrations.foundry = foundry;
  f.command('/ai triage');
  vi.spyOn(f.board.api.rest.issues, 'updateComment').mockRejectedValueOnce(
    new Error('interrupted audit write'),
  );
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'interrupted audit write',
  );
  f.board.integrations.foundry = undefined;
  f.command('/start', 'worker');
  await expect(f.board.applyCommands(1)).resolves.toMatchObject({
    accepted: 1,
  });
  expect(foundry.call).toHaveBeenCalledTimes(1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:ai-proposal'),
    ),
  ).toHaveLength(1);
  expect(f.issue.labels).toContain('status:in-progress');
});

it('audits Copilot HTTP-200 nonconfirmation as a terminal no-op without poisoning recovery or later commands', async () => {
  const f = fixture();
  const agentApi = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
    request: {
      fetch: async () =>
        new Response('{"assignees":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  });
  f.board.integrations.agentApi = agentApi;
  vi.spyOn(agentApi, 'graphql').mockResolvedValue({
    repository: {
      suggestedActors: {
        nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot' }],
      },
    },
  });
  const assign = vi.spyOn(agentApi.rest.issues, 'addAssignees');
  f.command('/copilot');
  f.command('/start', 'worker');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  await f.board.applyCommands(1);
  expect(assign).toHaveBeenCalledTimes(1);
  expect(f.issue.assignees).toEqual([{ login: 'worker' }]);
  expect(
    f.comments.some((comment) =>
      comment.body.includes('pronoia:copilot-error'),
    ),
  ).toBe(true);
  expect(
    f.comments.some((comment) =>
      comment.body.includes('pronoia:copilot-assignment'),
    ),
  ).toBe(false);
});
