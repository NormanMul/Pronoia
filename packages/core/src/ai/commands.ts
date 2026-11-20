import type { Octokit } from 'octokit';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Board, Issue } from '../github.js';
import { marker, readMeta } from '../assessment.js';
import { isAuditWriter, actorType, CommandError } from '../workflow/engine.js';
import { expectedState } from '../workflow/guards.js';
import { auditSchema, commandSchema, type Audit } from '../workflow/schemas.js';
import { repositoryScope } from '../security/alerts.js';
import { safeText } from '../security/findings.js';
import type { FoundryService } from './foundry.js';
import type { Role } from './roles.js';

const copilotLogin = 'copilot-swe-agent[bot]';
const receiptSchema = z.object({
  command_id: z.number().int().positive(),
  audit_comment_id: z.number().int().positive(),
});

export class CopilotUnavailableError extends CommandError {
  constructor(readonly comment_id: number) {
    super(
      'Copilot cloud agent is unavailable; verify the user token permissions, supported repository and main branch.',
    );
  }
}

async function receipt(
  board: Board,
  number: number,
  name: string,
  id: number,
): Promise<number | null> {
  for (const comment of await board.comments(number)) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = new RegExp(`<!-- pronoia:${name} (.*?) -->`, 's').exec(
      comment.body,
    );
    if (
      match?.[1] &&
      receiptSchema.parse(JSON.parse(match[1])).command_id === id
    )
      return comment.id;
  }
  return null;
}

function targetRepository(board: Board, issue: Issue): string {
  const target = readMeta(issue.body)?.finding?.repo ?? board.config.board_repo;
  if (
    target.toLowerCase() !== board.config.board_repo.toLowerCase() &&
    !board.config.targets.some(
      (item) => item.repo.toLowerCase() === target.toLowerCase(),
    )
  )
    throw new CommandError('Copilot target is not configured.');
  return target;
}

export async function checkCopilot(
  board: Board,
  issue: Issue,
  api: Octokit,
): Promise<void> {
  if (issue.assignees.some((user) => user.login.toLowerCase() === copilotLogin))
    return;
  const target = targetRepository(board, issue);
  for (const repo of new Set([board.config.board_repo, target])) {
    let available: boolean;
    try {
      const result = z
        .object({
          repository: z
            .object({
              suggestedActors: z.object({
                nodes: z.array(
                  z
                    .object({ login: z.string(), __typename: z.string() })
                    .nullable(),
                ),
              }),
            })
            .nullable(),
        })
        .parse(
          await api.graphql<unknown>(
            'query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{login __typename}}}}',
            {
              ...repositoryScope(repo),
              headers: { 'GraphQL-Features': 'coding_agent_model_selection' },
            },
          ),
        );
      available =
        result.repository?.suggestedActors.nodes.some(
          (actor) =>
            actor?.__typename === 'Bot' &&
            ['copilot-swe-agent', copilotLogin].includes(
              actor.login.toLowerCase(),
            ),
        ) ?? false;
    } catch {
      throw new CommandError(
        'Copilot cloud agent is unsupported or unavailable for this user token/repository; check the documented user-token permissions.',
      );
    }
    if (!available)
      throw new CommandError(
        'Copilot cloud agent is unsupported or not enabled for this user/repository.',
      );
  }
}

async function copilotFailure(
  board: Board,
  issue: Issue,
  audit: Audit,
  journal: number,
): Promise<never> {
  const previous = await receipt(
    board,
    issue.number,
    'copilot-error',
    audit.comment_id,
  );
  const id =
    previous ??
    (
      await board.comment(
        issue.number,
        `Copilot assignment unavailable. Verify the user token permissions, supported repository and main branch; no success was inferred.\n\n${marker('copilot-error', { command_id: audit.comment_id, audit_comment_id: journal })}`,
      )
    ).id;
  throw new CopilotUnavailableError(id);
}

export async function assignCopilot(
  board: Board,
  issue: Issue,
  audit: Audit,
  journal: number,
  api?: Octokit,
): Promise<{ assignees: string[]; comment_id: number }> {
  const failure = await receipt(
    board,
    issue.number,
    'copilot-error',
    audit.comment_id,
  );
  if (failure) throw new CopilotUnavailableError(failure);
  const existing = await receipt(
    board,
    issue.number,
    'copilot-assignment',
    audit.comment_id,
  );
  let fresh = await board.issue(issue.number);
  let assignees = fresh.assignees.map((user) => user.login);
  const target = targetRepository(board, issue);
  if (
    !existing &&
    !assignees.some((login) => login.toLowerCase() === copilotLogin)
  ) {
    if (!api) return copilotFailure(board, issue, audit, journal);
    try {
      await checkCopilot(board, fresh, api);
    } catch (error) {
      if (error instanceof CommandError)
        return copilotFailure(board, issue, audit, journal);
      throw error;
    }
    const assignment = {
      ...board.scope,
      issue_number: issue.number,
      assignees: [copilotLogin],
      agent_assignment: {
        target_repo: target,
        base_branch: 'main',
        custom_instructions: `Refs ${target.toLowerCase() === board.config.board_repo.toLowerCase() ? `#${issue.number}` : `${board.config.board_repo}#${issue.number}`}, never Fixes/Closes. Add tests. Do not modify workflows.`,
      },
    };
    let data: unknown;
    try {
      data = (await api.rest.issues.addAssignees(assignment)).data;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        [401, 403, 404, 422].includes(Number(error.status))
      )
        return copilotFailure(board, issue, audit, journal);
      throw error;
    }
    const result = z
      .object({ assignees: z.array(z.object({ login: z.string().min(1) })) })
      .parse(data);
    if (
      !result.assignees.some(
        (user) => user.login.toLowerCase() === copilotLogin,
      )
    )
      return copilotFailure(board, issue, audit, journal);
    fresh = await board.issue(issue.number);
    assignees = [
      ...new Set([
        ...fresh.assignees.map((user) => user.login),
        ...result.assignees.map((user) => user.login),
      ]),
    ];
  }
  if (existing)
    return {
      assignees: [...new Set([...assignees, ...audit.state.assignees])],
      comment_id: existing,
    };
  const comment = await board.comment(
    issue.number,
    `Copilot assignment confirmed/reused. Refs only; tests required; workflow changes forbidden.\n\n${marker('copilot-assignment', { command_id: audit.comment_id, audit_comment_id: journal, agent: copilotLogin, target_repo: target, assignees })}`,
  );
  return { assignees, comment_id: comment.id };
}

export async function proposeAi(
  board: Board,
  issue: Issue,
  audit: Audit,
  journal: number,
  foundry?: FoundryService,
): Promise<number> {
  const previous = await receipt(
    board,
    issue.number,
    'ai-proposal',
    audit.comment_id,
  );
  await board.setupLabels(['ai:proposal']);
  let id = previous;
  if (!id) {
    if (!foundry)
      throw new CommandError(
        'Foundry is not configured; no /ai proposal can be generated.',
      );
    const mode = audit.command.aiMode;
    if (!mode) throw new CommandError('A supported /ai mode is required.');
    const role: Role =
      mode === 'summarize'
        ? 'Scribe'
        : mode === 'test-plan'
          ? 'Coach'
          : 'Triage';
    const meta = readMeta(issue.body);
    const references = [
      ...new Set([
        `https://github.com/${board.config.board_repo}/issues/${issue.number}`,
        ...(meta?.finding?.link ? [meta.finding.link] : []),
        ...(meta?.finding?.ghsa_ids.map(
          (ghsa) => `https://github.com/advisories/${ghsa}`,
        ) ?? []),
      ]),
    ];
    const response = await foundry.call(
      role,
      {
        text: JSON.stringify({
          requested_mode: mode,
          issue: {
            number: issue.number,
            title: safeText(issue.title),
            body: safeText(issue.body),
            metadata: meta,
          },
        }).slice(0, 48000),
      },
      {
        config: board.config,
        issues: [{ number: issue.number, state: audit.state }],
        references,
        at: audit.at,
      },
    );
    const output = JSON.stringify(
      response.ok ? response.value : { error: response.error },
      null,
      2,
    )
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e');
    const comment = await board.comment(
      issue.number,
      [
        `## AI proposal — ${mode}`,
        'Review only. No command was executed by this proposal. Verbal decisions are data; recaps require human review.',
        `\`\`\`json\n${output}\n\`\`\``,
        ...response.warnings.map(
          (warning) =>
            `Warning: ${safeText(warning).replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`,
        ),
        marker('ai-proposal', {
          command_id: audit.comment_id,
          audit_comment_id: journal,
          mode,
          role,
          usage: response.usage,
          ok: response.ok,
        }),
      ].join('\n\n'),
    );
    id = comment.id;
  }
  await board.api.rest.issues.addLabels({
    ...board.scope,
    issue_number: issue.number,
    labels: ['ai:proposal'],
  });
  return id;
}

async function verifiedHumanRequester(
  board: Board,
  username: string,
): Promise<string> {
  const user = z
    .object({ login: z.string().min(1), type: z.enum(['User', 'Bot']) })
    .parse((await board.api.rest.users.getByUsername({ username })).data);
  const permission = z.object({ permission: z.string() }).parse(
    (
      await board.api.rest.repos.getCollaboratorPermissionLevel({
        ...board.scope,
        username: user.login,
      })
    ).data,
  );
  if (
    !['write', 'maintain', 'admin'].includes(permission.permission) ||
    actorType(
      { login: user.login, userType: user.type, association: 'COLLABORATOR' },
      board.config,
    ) !== 'human'
  )
    throw new CommandError(
      'Manual AI requires a human collaborator with write permission.',
    );
  return user.login;
}

const manualAiRequestSchema = z.object({
  run_id: z.number().int().positive(),
  requester: z.string().min(1),
  mode: commandSchema.shape.aiMode.unwrap(),
});

export async function queueManualAi(
  board: Board,
  number: number,
  mode: NonNullable<Audit['command']['aiMode']>,
): Promise<{ request_comment_id: number }> {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    !process.env.GITHUB_EVENT_PATH
  )
    throw new CommandError(
      'Manual AI requests are collaborator-only GitHub Actions workflow_dispatch operations.',
    );
  const event = z
    .object({ sender: z.object({ login: z.string().min(1) }) })
    .parse(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  const requester = await verifiedHumanRequester(board, event.sender.login);
  const issue = await board.issue(number);
  if (!issue.labels.includes('pronoia') || issue.pull_request)
    throw new CommandError('Manual AI requires a Pronoia assessment issue.');
  const run = z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.GITHUB_RUN_ID);
  const comments = await board.comments(number);
  let requestId: number | null = null;
  for (const comment of comments) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = /<!-- pronoia:ai-request (.*?) -->/s.exec(comment.body);
    if (match?.[1]) {
      const request = manualAiRequestSchema.parse(JSON.parse(match[1]));
      if (
        request.run_id === run &&
        request.requester === requester &&
        request.mode === mode
      )
        requestId = comment.id;
    }
  }
  if (!requestId) {
    const comment = await board.comment(
      number,
      `AI proposal requested manually by @${requester}; collaborator permission verified. No status command is implied.\n\n${marker('ai-request', { run_id: run, requester, mode })}`,
    );
    if (!comment.user || !isAuditWriter(comment.user.login))
      throw new CommandError(
        'Manual AI must publish through the authoritative Actions writer.',
      );
    requestId = comment.id;
  }
  return { request_comment_id: requestId };
}

export async function completeManualAi(
  board: Board,
  foundry: FoundryService,
  number: number,
  requestId: number,
): Promise<{ request_comment_id: number; proposal_comment_id: number }> {
  const comments = await board.comments(number);
  const comment = comments.find((entry) => entry.id === requestId);
  if (!comment?.user || !isAuditWriter(comment.user.login))
    throw new CommandError(
      'Manual AI intent must be written by the actual Actions identity.',
    );
  const match = /<!-- pronoia:ai-request (.*?) -->/s.exec(comment.body);
  if (!match?.[1]) throw new CommandError('Manual AI intent is missing.');
  const request = manualAiRequestSchema.parse(JSON.parse(match[1]));
  const requester = await verifiedHumanRequester(board, request.requester);
  const issue = await board.issue(number);
  if (!issue.labels.includes('pronoia') || issue.pull_request)
    throw new CommandError('Manual AI requires a Pronoia assessment issue.');
  const state = expectedState(issue, comments, board.config);
  const audit = auditSchema.parse({
    from: state.status,
    to: state.status,
    command: { name: 'ai', aiMode: request.mode, reason: request.mode },
    actor: requester,
    actor_type: 'human',
    on_behalf_of: '',
    reason: request.mode,
    evidence_count: state.evidence_count,
    at: new Date().toISOString(),
    comment_id: requestId,
    state,
  });
  return {
    request_comment_id: requestId,
    proposal_comment_id: await proposeAi(
      board,
      issue,
      audit,
      requestId,
      foundry,
    ),
  };
}

export async function requestManualAi(
  board: Board,
  foundry: FoundryService,
  number: number,
  mode: NonNullable<Audit['command']['aiMode']>,
): Promise<{ request_comment_id: number; proposal_comment_id: number }> {
  const request = await queueManualAi(board, number, mode);
  return completeManualAi(board, foundry, number, request.request_comment_id);
}
