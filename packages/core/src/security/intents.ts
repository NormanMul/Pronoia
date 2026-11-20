import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Board } from '../github.js';
import { marker } from '../assessment.js';
import { isAuditWriter, CommandError } from '../workflow/engine.js';
import { completeManualAi } from '../ai/commands.js';
import { SecurityAlerts, mergedReferences } from './alerts.js';
import { verifyOnMerge } from './sync.js';

const mergeIntentSchema = z.object({
  issue: z.number().int().positive(),
  pull: z.number().int().positive(),
  requester: z.string().min(1),
  run_id: z.number().int().positive(),
});

export async function queueMergeIntents(
  board: Board,
  pull: number,
): Promise<{ issues: number[]; intent_ids: number[] }> {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    !process.env.GITHUB_EVENT_PATH ||
    !['pull_request', 'workflow_dispatch'].includes(
      process.env.GITHUB_EVENT_NAME ?? '',
    )
  )
    throw new CommandError(
      'Merge discovery requires an authenticated Actions event.',
    );
  const event = z
    .object({
      sender: z.object({ login: z.string().min(1) }),
      pull_request: z
        .object({ number: z.number().int().positive() })
        .optional(),
    })
    .parse(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  if (
    process.env.GITHUB_EVENT_NAME === 'pull_request' &&
    event.pull_request?.number !== pull
  )
    throw new CommandError('Merge discovery must match the actual PR event.');
  const requester = z
    .object({ login: z.string().min(1), type: z.enum(['User', 'Bot']) })
    .parse(
      (
        await board.api.rest.users.getByUsername({
          username: event.sender.login,
        })
      ).data,
    );
  const runId = z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.GITHUB_RUN_ID);
  const pr = (
    await board.api.rest.pulls.get({
      ...board.scope,
      pull_number: z.number().int().positive().parse(pull),
    })
  ).data;
  const existing = new Set((await board.issues()).map((issue) => issue.number));
  const issues = mergedReferences(pr, board.config.board_repo).filter(
    (number) => existing.has(number),
  );
  const ids: number[] = [];
  for (const issue of issues) {
    let id: number | undefined;
    for (const comment of await board.comments(issue)) {
      if (!comment.user || !isAuditWriter(comment.user.login)) continue;
      const match = /<!-- pronoia:merge-intent (.*?) -->/s.exec(comment.body);
      if (match?.[1]) {
        const intent = mergeIntentSchema.parse(JSON.parse(match[1]));
        if (intent.issue === issue && intent.pull === pull) id = comment.id;
      }
    }
    if (!id) {
      const comment = await board.comment(
        issue,
        `Merged-PR verification queued by the actual GitHub event requester @${requester.login}; no status was written by discovery.\n\n${marker('merge-intent', { issue, pull, requester: requester.login, run_id: runId })}`,
      );
      if (!comment.user || !isAuditWriter(comment.user.login))
        throw new CommandError(
          'Merge intent requires the authoritative Actions writer.',
        );
      id = comment.id;
    }
    ids.push(id);
  }
  return { issues, intent_ids: ids };
}

export async function consumeIssueIntents(
  board: Board,
  alerts: SecurityAlerts,
  number: number,
): Promise<{ completed: number; pending: number; warnings: string[] }> {
  const comments = await board.comments(number);
  const completed = new Set<number>();
  for (const comment of comments) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = /<!-- pronoia:intent-result (.*?) -->/s.exec(comment.body);
    if (match?.[1])
      completed.add(
        z
          .object({ intent_comment_id: z.number().int().positive() })
          .parse(JSON.parse(match[1])).intent_comment_id,
      );
  }
  const result = { completed: 0, pending: 0, warnings: [] as string[] };
  for (const comment of comments) {
    if (
      !comment.user ||
      !isAuditWriter(comment.user.login) ||
      completed.has(comment.id)
    )
      continue;
    const merge = /<!-- pronoia:merge-intent (.*?) -->/s.exec(comment.body);
    const ai = /<!-- pronoia:ai-request (.*?) -->/s.test(comment.body);
    if (!merge && !ai) continue;
    let outcome: Record<string, unknown>;
    if (merge?.[1]) {
      const intent = mergeIntentSchema.parse(JSON.parse(merge[1]));
      if (intent.issue !== number)
        throw new CommandError('Merge intent belongs to a different issue.');
      outcome = await verifyOnMerge(board, alerts, intent.pull, number);
    } else {
      if (!board.integrations.foundry) {
        result.pending += 1;
        result.warnings.push(
          `Manual AI intent ${comment.id} remains pending: Foundry is not configured.`,
        );
        continue;
      }
      try {
        outcome = await completeManualAi(
          board,
          board.integrations.foundry,
          number,
          comment.id,
        );
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        outcome = { rejected: true, reason: error.message };
      }
    }
    await board.comment(
      number,
      `Durable ${merge ? 'merge' : 'AI'} intent processed.\n\n${marker('intent-result', { intent_comment_id: comment.id, ...outcome })}`,
    );
    result.completed += 1;
  }
  return result;
}
