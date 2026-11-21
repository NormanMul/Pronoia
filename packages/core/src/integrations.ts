import { Octokit } from 'octokit';
import { z } from 'zod';
import { marker } from './assessment.js';
import type { Board, IssueComment } from './github.js';
import {
  boundedFetch,
  IntegrationError,
  integrationFailure,
} from './integration-io.js';
import { isAuditWriter, readAudit } from './workflow/engine.js';
import { expectedState } from './workflow/guards.js';
import type { Status } from './workflow/schemas.js';

export {
  uploadSharePoint,
  type SharePointOptions,
  type SharePointReport,
} from './integration-io.js';

export type IntegrationOptions = {
  projectToken?: string;
  teamsWebhook?: string;
  fetch?: typeof fetch;
};
export type IntegrationReport = {
  project: string;
  teams: string;
  warnings: string[];
};

const stages: Record<Status, string> = {
  todo: 'To Do',
  'in-progress': 'In Progress',
  validate: 'Validate',
  blocked: 'Blocked',
  done: 'Done',
};
const idSchema = z.string().min(1).max(400);
const selectOptionSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  color: z.enum([
    'BLUE',
    'GRAY',
    'GREEN',
    'ORANGE',
    'PINK',
    'PURPLE',
    'RED',
    'YELLOW',
  ]),
});
const fieldSchema = z
  .object({
    __typename: z.string(),
    id: idSchema,
    name: z.string(),
    options: z.array(selectOptionSchema).optional(),
  })
  .refine(
    (field) =>
      field.__typename !== 'ProjectV2SingleSelectField' ||
      field.options !== undefined,
    'Single-select fields must return their options.',
  );
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const valueSchema = z
  .union([
    z.object({
      __typename: z.literal('ProjectV2ItemFieldSingleSelectValue'),
      name: z.string().nullable(),
      optionId: idSchema.nullable(),
    }),
    z.object({
      __typename: z
        .string()
        .refine((name) => name !== 'ProjectV2ItemFieldSingleSelectValue'),
    }),
  ])
  .nullable();
const memberSchema = z.object({
  id: idSchema,
  project: z.object({ id: idSchema }),
  fieldValueByName: valueSchema,
});
const projectItemSchema = z.object({
  id: idSchema,
  content: z
    .union([
      z.object({
        __typename: z.literal('Issue'),
        id: idSchema,
        number: z.number().int().positive(),
        repository: z.object({ nameWithOwner: z.string() }),
      }),
      z.object({ __typename: z.string().refine((name) => name !== 'Issue') }),
    ])
    .nullable(),
  fieldValueByName: valueSchema,
});
const receiptSchema = z
  .object({
    schema_version: z.literal(1),
    channel: z.literal('teams'),
    audit_comment_id: z.number().int().positive(),
  })
  .strict();

async function actionsIdentity(board: Board): Promise<void> {
  const actor = z
    .object({ viewer: z.object({ login: z.string() }) })
    .parse(
      await board.api.graphql<unknown>(
        'query PronoiaIntegrationActor { viewer { login } }',
      ),
    );
  if (!isAuditWriter(actor.viewer.login))
    throw new IntegrationError(
      'Integration hooks require the returned github-actions[bot] identity and the Actions GITHUB_TOKEN.',
    );
}

async function pages<T>(
  load: (after: string | null) => Promise<{
    nodes: (T | null)[];
    pageInfo: z.infer<typeof pageInfoSchema>;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const result = await load(after);
    rows.push(...result.nodes.filter((node): node is T => node !== null));
    if (!result.pageInfo.hasNextPage) return rows;
    after = result.pageInfo.endCursor;
    if (!after || seen.has(after))
      throw new IntegrationError(
        'Projects returned an invalid pagination cursor.',
      );
    seen.add(after);
  }
  throw new IntegrationError(
    'Projects pagination exceeds 10,000 items; reduce the project scope.',
  );
}

async function projectContext(
  board: Board,
  token: string,
  transport: typeof fetch,
) {
  const config = board.config.project;
  if (!config || config.field !== 'Stage')
    throw new IntegrationError(
      'Configure project.owner, project.number and the single-select field Stage.',
    );
  z.string().min(1).max(10000).parse(token);
  const projectFetch: typeof fetch = (input, init) =>
    boundedFetch(transport, input, init);
  const createFieldFetch: typeof fetch = (input, init) =>
    boundedFetch(transport, input, init, 1);
  const api = new Octokit({
    auth: token,
    request: { fetch: projectFetch },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const result = z
    .object({
      repositoryOwner: z
        .object({
          __typename: z.enum(['User', 'Organization']),
          projectV2: z.object({ id: idSchema }).nullable(),
        })
        .nullable(),
    })
    .parse(
      await api.graphql<unknown>(
        `
    query PronoiaProject($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        __typename
        ... on User { projectV2(number: $number) { id } }
        ... on Organization { projectV2(number: $number) { id } }
      }
    }`,
        { owner: config.owner, number: config.number },
      ),
    );
  const projectId = result.repositoryOwner?.projectV2?.id;
  if (!projectId)
    throw new IntegrationError(
      'Configured Project was not found or the separate Projects token cannot access it.',
    );
  const fields = await pages(async (after) => {
    const response = z
      .object({
        node: z.object({
          fields: z.object({
            nodes: z.array(fieldSchema.nullable()).max(100),
            pageInfo: pageInfoSchema,
          }),
        }),
      })
      .parse(
        await api.graphql<unknown>(
          `
      query PronoiaProjectFields($projectId: ID!, $after: String) {
        node(id: $projectId) { ... on ProjectV2 {
          fields(first: 100, after: $after) { nodes {
            __typename
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField { options { id name color description } }
          } pageInfo { hasNextPage endCursor } }
        } }
      }`,
          { projectId, after },
        ),
      );
    return response.node.fields;
  });
  let field = fields.find((candidate) => candidate.name === 'Stage');
  if (field && field.__typename !== 'ProjectV2SingleSelectField')
    throw new IntegrationError(
      'Stage must be a single-select field; change it manually rather than replacing existing data.',
    );
  const required = Object.values(stages);
  const additions = required
    .filter((name) => !field?.options?.some((option) => option.name === name))
    .map((name) => ({
      name,
      description: 'Mirror of the authoritative Pronoia issue audit.',
      color: 'GRAY',
    }));
  const selection = `projectV2Field {
    __typename ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { options { id name color description } }
  }`;
  if (!field) {
    const created = z
      .object({
        createProjectV2Field: z.object({ projectV2Field: fieldSchema }),
      })
      .parse(
        await api.graphql<unknown>(
          `
        mutation PronoiaCreateStage($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) { ${selection} }
        }`,
          {
            input: {
              projectId,
              name: 'Stage',
              dataType: 'SINGLE_SELECT',
              singleSelectOptions: additions,
            },
            // Field creation has no documented idempotency guarantee on a lost acknowledgement.
            request: { fetch: createFieldFetch },
          },
        ),
      );
    field = created.createProjectV2Field.projectV2Field;
  } else if (additions.length) {
    const updated = z
      .object({
        updateProjectV2Field: z.object({ projectV2Field: fieldSchema }),
      })
      .parse(
        await api.graphql<unknown>(
          `
        mutation PronoiaCompleteStage($input: UpdateProjectV2FieldInput!) {
          updateProjectV2Field(input: $input) { ${selection} }
        }`,
          {
            input: {
              fieldId: field.id,
              singleSelectOptions: [...(field.options ?? []), ...additions],
            },
          },
        ),
      );
    field = updated.updateProjectV2Field.projectV2Field;
  }
  if (
    field.__typename !== 'ProjectV2SingleSelectField' ||
    !required.every(
      (name) =>
        field.options?.filter((option) => option.name === name).length === 1,
    )
  )
    throw new IntegrationError(
      'Stage must have one each of To Do, In Progress, Validate, Blocked and Done.',
    );
  return { api, projectId, field };
}

async function mirrorStage(
  project: Awaited<ReturnType<typeof projectContext>>,
  itemId: string,
  current: z.infer<typeof valueSchema>,
  status: Status,
): Promise<boolean> {
  const option = project.field.options?.find(
    (candidate) => candidate.name === stages[status],
  );
  if (!option)
    throw new IntegrationError(
      'Stage is missing its required canonical option.',
    );
  if (current && !('optionId' in current))
    throw new IntegrationError(
      'The configured Project Stage value must be single-select.',
    );
  if (current?.optionId === option.id) return false;
  const response = z
    .object({
      updateProjectV2ItemFieldValue: z.object({
        projectV2Item: z.object({ id: idSchema }),
      }),
    })
    .parse(
      await project.api.graphql<unknown>(
        `
    mutation PronoiaMirrorStage($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
    }`,
        {
          input: {
            projectId: project.projectId,
            itemId,
            fieldId: project.field.id,
            value: { singleSelectOptionId: option.id },
          },
        },
      ),
    );
  if (response.updateProjectV2ItemFieldValue.projectV2Item.id !== itemId)
    throw new IntegrationError('Projects returned an unexpected updated item.');
  return true;
}

function trustedReceipt(comments: IssueComment[], auditId: number): boolean {
  return comments.some((comment) => {
    if (comment.user?.type !== 'Bot' || !isAuditWriter(comment.user.login))
      return false;
    const match = /<!-- pronoia:notification-receipt (.*?) -->/s.exec(
      comment.body,
    );
    return match?.[1]
      ? receiptSchema.parse(JSON.parse(match[1])).audit_comment_id === auditId
      : false;
  });
}

function workflowsUrl(raw: string): string {
  const parsed = z.url().safeParse(raw);
  if (!parsed.success)
    throw new IntegrationError(
      'Teams requires a valid HTTPS Workflows webhook URL.',
    );
  const url = new URL(parsed.data);
  const host =
    /^(?:[a-z0-9-]+\.)+api\.powerplatform\.com$/.test(url.hostname) ||
    /^(?:[a-z0-9-]+\.)+logic\.azure\.com$/.test(url.hostname);
  const path =
    /^(?:\/powerautomate\/automations\/direct)?\/workflows\/[A-Za-z0-9-]+\/triggers\/[A-Za-z0-9_-]+\/paths\/invoke$/.test(
      url.pathname,
    );
  if (
    url.protocol !== 'https:' ||
    !host ||
    !path ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new IntegrationError(
      'Teams requires a trusted HTTPS Power Automate Workflows trigger URL; connector and arbitrary URLs are refused.',
    );
  return url.href;
}

export async function integrationHooks(
  board: Board,
  issue: number,
  options: IntegrationOptions = {},
): Promise<IntegrationReport> {
  const report: IntegrationReport = {
    project: 'skipped',
    teams: 'skipped',
    warnings: [],
  };
  const projectEnabled = Boolean(board.config.project && options.projectToken);
  if (!board.config.project)
    report.warnings.push(
      'Projects skipped: configure project.owner, project.number and Stage.',
    );
  else if (!options.projectToken)
    report.warnings.push(
      'Projects skipped: set the separate PRONOIA_PROJECT_TOKEN.',
    );
  if (!options.teamsWebhook)
    report.warnings.push('Teams skipped: set TEAMS_WORKFLOW_WEBHOOK_URL.');
  if (!projectEnabled && !options.teamsWebhook) return report;
  let comments: IssueComment[];
  let status: Status;
  try {
    z.number().int().positive().parse(issue);
    await actionsIdentity(board);
    const finding = await board.issue(issue);
    if (!finding.labels.includes('pronoia') || finding.pull_request)
      throw new IntegrationError(
        'Integration hooks accept only existing Pronoia issues in the configured board.',
      );
    comments = (await board.comments(issue)).sort((a, b) => a.id - b.id);
    status = expectedState(finding, comments, board.config).status;
  } catch (error) {
    if (projectEnabled) report.project = 'degraded';
    if (options.teamsWebhook) report.teams = 'degraded';
    report.warnings.push(integrationFailure(error));
    return report;
  }
  const transport = options.fetch ?? fetch;
  if (projectEnabled && options.projectToken) {
    try {
      const project = await projectContext(
        board,
        options.projectToken,
        transport,
      );
      let contentId = '';
      const members = await pages(async (after) => {
        const response = z
          .object({
            repository: z.object({
              issue: z.object({
                id: idSchema,
                projectItems: z.object({
                  nodes: z.array(memberSchema.nullable()).max(100),
                  pageInfo: pageInfoSchema,
                }),
              }),
            }),
          })
          .parse(
            await project.api.graphql<unknown>(
              `
          query PronoiaIssueProjects($owner: String!, $repo: String!, $issue: Int!, $after: String) {
            repository(owner: $owner, name: $repo) { issue(number: $issue) {
              id projectItems(first: 100, after: $after) { nodes {
                id project { id }
                fieldValueByName(name: "Stage") { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
              } pageInfo { hasNextPage endCursor } }
            } }
          }`,
              { ...board.scope, issue, after },
            ),
          );
        contentId = response.repository.issue.id;
        return response.repository.issue.projectItems;
      });
      const member = members.find(
        (candidate) => candidate.project.id === project.projectId,
      );
      const itemId =
        member?.id ??
        z
          .object({
            addProjectV2ItemById: z.object({
              item: z.object({ id: idSchema }),
            }),
          })
          .parse(
            await project.api.graphql<unknown>(
              `
        mutation PronoiaAddProjectIssue($input: AddProjectV2ItemByIdInput!) {
          addProjectV2ItemById(input: $input) { item { id } }
        }`,
              { input: { projectId: project.projectId, contentId } },
            ),
          ).addProjectV2ItemById.item.id;
      report.project = (await mirrorStage(
        project,
        itemId,
        member?.fieldValueByName ?? null,
        status,
      ))
        ? 'mirrored'
        : 'unchanged';
    } catch (error) {
      report.project = 'degraded';
      report.warnings.push(`Projects: ${integrationFailure(error)}`);
    }
  }
  if (options.teamsWebhook) {
    let accepted = false;
    try {
      const url = workflowsUrl(options.teamsWebhook);
      const latest = comments
        .flatMap((comment) => {
          const audit = readAudit(comment.body, comment.user?.login ?? '');
          return audit && audit.from !== audit.to && !audit.failure_reason
            ? [{ audit, id: comment.id }]
            : [];
        })
        .at(-1);
      if (
        !latest ||
        latest.audit.to !== status ||
        !['validate', 'blocked', 'done'].includes(status)
      )
        report.warnings.push(
          'Teams skipped: no latest trusted transition into Validate, Blocked or Done.',
        );
      else if (trustedReceipt(comments, latest.id)) report.teams = 'unchanged';
      else {
        const wording =
          status === 'validate'
            ? 'Human review is required on GitHub. A different, uninvolved human must review the evidence before approving. This notification grants no authority.'
            : status === 'blocked'
              ? 'A human should review the blocker on GitHub. This notification cannot change issue status.'
              : 'Done was recorded by the governed GitHub workflow after human review. This notification is informational and cannot approve or change status.';
        const response = await boundedFetch(transport, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'message',
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive',
                contentUrl: null,
                content: {
                  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                  type: 'AdaptiveCard',
                  version: '1.2',
                  body: [
                    {
                      type: 'TextBlock',
                      text: `Pronoia #${issue}: ${stages[status]}`,
                      weight: 'Bolder',
                      wrap: true,
                    },
                    { type: 'TextBlock', text: wording, wrap: true },
                  ],
                  actions: [
                    {
                      type: 'Action.OpenUrl',
                      title: 'Review on GitHub',
                      url: `https://github.com/${board.config.board_repo}/issues/${issue}`,
                    },
                  ],
                },
              },
            ],
          }),
        });
        if (!response.ok)
          throw new IntegrationError(
            `Teams HTTP ${response.status}; check the Workflows URL, trigger authentication and flow owner.`,
          );
        accepted = true;
        const receipt = await board.comment(
          issue,
          `Teams Workflows accepted this review-only notification.\n\n${marker(
            'notification-receipt',
            receiptSchema.parse({
              schema_version: 1,
              channel: 'teams',
              audit_comment_id: latest.id,
            }),
          )}`,
        );
        if (receipt.user?.type !== 'Bot' || !isAuditWriter(receipt.user.login))
          throw new IntegrationError(
            'Teams receipt was not returned as github-actions[bot].',
          );
        report.teams = 'sent';
      }
    } catch (error) {
      report.teams = 'degraded';
      report.warnings.push(
        accepted
          ? 'Teams webhook accepted, but the bot-owned receipt was not recorded; retry may duplicate the card.'
          : `Teams: ${integrationFailure(error)}`,
      );
    }
  }
  return report;
}

export async function reconcileProject(
  board: Board,
  projectToken: string,
  options: { fetch?: typeof fetch } = {},
): Promise<{ scanned: number; repaired: number; warnings: string[] }> {
  const report = { scanned: 0, repaired: 0, warnings: [] as string[] };
  if (!board.config.project || !projectToken) {
    report.warnings.push(
      'Projects skipped: configure the Project and set the separate PRONOIA_PROJECT_TOKEN.',
    );
    return report;
  }
  try {
    await actionsIdentity(board);
    const project = await projectContext(
      board,
      projectToken,
      options.fetch ?? fetch,
    );
    const items = await pages(async (after) => {
      const response = z
        .object({
          node: z.object({
            items: z.object({
              nodes: z.array(projectItemSchema.nullable()).max(100),
              pageInfo: pageInfoSchema,
            }),
          }),
        })
        .parse(
          await project.api.graphql<unknown>(
            `
        query PronoiaProjectItems($projectId: ID!, $after: String) {
          node(id: $projectId) { ... on ProjectV2 {
            items(first: 100, after: $after) { nodes {
              id content { __typename ... on Issue { id number repository { nameWithOwner } } }
              fieldValueByName(name: "Stage") { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
            } pageInfo { hasNextPage endCursor } }
          } }
        }`,
            { projectId: project.projectId, after },
          ),
        );
      return response.node.items;
    });
    for (const item of items) {
      if (
        !item.content ||
        !('repository' in item.content) ||
        item.content.repository.nameWithOwner.toLowerCase() !==
          board.config.board_repo.toLowerCase()
      )
        continue;
      const issueNumber = item.content.number;
      try {
        const issue = await board.issue(issueNumber);
        if (!issue.labels.includes('pronoia') || issue.pull_request) continue;
        const comments = (await board.comments(issue.number)).sort(
          (a, b) => a.id - b.id,
        );
        const status = expectedState(issue, comments, board.config).status;
        report.scanned += 1;
        if (
          await mirrorStage(project, item.id, item.fieldValueByName, status)
        ) {
          report.repaired += 1;
          await board.comment(
            issue.number,
            `Project Stage was reverted to **${stages[status]}** from the trusted issue audit. Stage is a mirror, not a status writer; review and use governed commands on GitHub instead of dragging the card.`,
          );
        }
      } catch (error) {
        report.warnings.push(
          `Project issue #${issueNumber}: ${integrationFailure(error)}`,
        );
      }
    }
  } catch (error) {
    report.warnings.push(`Projects: ${integrationFailure(error)}`);
  }
  return report;
}
