import type { Config } from '../config.js';
import { readMeta } from '../assessment.js';
import { readAudit } from './engine.js';
import { severitySchema, stateSchema, type WorkflowState } from './schemas.js';

type GuardIssue = {
  number: number;
  labels: string[];
  assignees: { login: string }[];
  body: string;
  state: 'open' | 'closed';
};
type GuardComment = { body: string; user: { login: string } | null };

export function expectedState(
  issue: GuardIssue,
  comments: GuardComment[],
  config: Config,
): WorkflowState {
  const meta = readMeta(issue.body);
  let state = stateSchema.parse({
    evidence_required:
      meta?.evidence_required ??
      config.governance.evidence_required_for_approve,
    due_date: meta?.due_date ?? null,
  });
  for (const comment of comments) {
    if (!comment.user) continue;
    const audit = readAudit(comment.body, comment.user.login);
    if (audit) state = audit.state;
  }
  state.assignees = issue.assignees.map((user) => user.login);
  const severity = issue.labels
    .find((label) => label.startsWith('severity:'))
    ?.slice(9);
  if (severity) state.severity = severitySchema.parse(severity);
  return state;
}

export function guardPlan(
  issue: GuardIssue,
  comments: GuardComment[],
  config: Config,
): {
  status: WorkflowState['status'];
  reopen: boolean;
  close: boolean;
  relabel: boolean;
} {
  const state = expectedState(issue, comments, config);
  const statuses = issue.labels.filter((label) => label.startsWith('status:'));
  return {
    status: state.status,
    reopen: issue.state === 'closed' && state.status !== 'done',
    close: issue.state === 'open' && state.status === 'done',
    relabel: statuses.length !== 1 || statuses[0] !== `status:${state.status}`,
  };
}
