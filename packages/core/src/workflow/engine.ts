import { z } from 'zod';
import type { Config } from '../config.js';
import {
  auditSchema,
  commandSchema,
  stateSchema,
  type Actor,
  type Audit,
  type Command,
  type Status,
  type WorkflowState,
} from './schemas.js';

export class CommandError extends Error {}

export function isAuditWriter(login: string): boolean {
  return login.toLowerCase() === 'github-actions[bot]';
}

export function dateInWib(at: string): string {
  return new Date(Date.parse(at) + 7 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

const fromStatuses: Record<Command['name'], readonly Status[]> = {
  start: ['todo', 'blocked'],
  validate: ['todo', 'in-progress', 'blocked'],
  approve: ['validate'],
  reject: ['validate'],
  dispute: ['todo', 'in-progress', 'blocked'],
  block: ['todo', 'in-progress', 'validate'],
  unblock: ['blocked'],
  reopen: ['done'],
  confirm: ['todo', 'in-progress', 'validate', 'blocked'],
  assign: ['todo', 'in-progress', 'validate', 'blocked', 'done'],
  severity: ['todo', 'in-progress', 'validate', 'blocked', 'done'],
  due: ['todo', 'in-progress', 'validate', 'blocked', 'done'],
  copilot: ['todo', 'in-progress'],
  ai: ['todo', 'in-progress', 'validate', 'blocked', 'done'],
};
const agentCommands = new Set<Command['name']>([
  'start',
  'validate',
  'block',
  'reopen',
]);

export function isAutomation(login: string, config: Config): boolean {
  const normalized = login.toLowerCase();
  return (
    normalized === 'github-actions[bot]' ||
    config.governance.automation_logins.some(
      (value) => value.toLowerCase() === normalized,
    )
  );
}

export function actorType(
  actor: Actor,
  config: Config,
): 'human' | 'agent' | 'automation' {
  if (isAutomation(actor.login, config)) {
    return 'automation';
  }
  return actor.agent ||
    actor.userType === 'Bot' ||
    actor.login.endsWith('[bot]')
    ? 'agent'
    : 'human';
}

export function allowedCommands(
  status: Status,
  actor: Actor,
  config: Config,
): Command['name'][] {
  return commandSchema.shape.name.options.filter(
    (name) =>
      fromStatuses[name].includes(status) &&
      (actorType(actor, config) === 'human' || agentCommands.has(name)),
  );
}

export function parseCommand(body: string): Command | null {
  if (!body.startsWith('/')) return null;
  if (body.length > 65536) throw new CommandError('Comment is too long.');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const match = /^\/([a-z-]+)(?:[ \t]+(.*))?$/i.exec(firstLine.trimEnd());
  if (!match) throw new CommandError('Invalid first-line command.');
  const name = commandSchema.shape.name.safeParse(match[1]?.toLowerCase());
  if (!name.success) throw new CommandError('Unknown command.');
  const reason = (match[2] ?? '').trim();
  const validatedNames = [...body.matchAll(/^Validated-by:[ \t]*(.+)$/gim)];
  if (validatedNames.length > 1) {
    throw new CommandError('Use at most one Validated-by line.');
  }
  const command: Command = {
    name: name.data,
    reason,
    validatedBy: validatedNames[0]?.[1]?.trim() ?? '',
  };
  switch (command.name) {
    case 'start':
    case 'approve':
    case 'unblock':
      if (reason)
        throw new CommandError(`/${command.name} takes no arguments.`);
      break;
    case 'reject':
    case 'block':
    case 'reopen':
      if (!reason)
        throw new CommandError('A reason is required on the first line.');
      break;
    case 'dispute': {
      const parts = /^(\S+)(?:\s+until=(\S+))?(?:\s+(.+))?$/.exec(reason);
      command.disputeType = z
        .enum(['false-positive', 'not-applicable', 'risk-accepted'])
        .parse(parts?.[1]);
      command.reason = parts?.[3]?.trim() ?? '';
      if (!command.reason)
        throw new CommandError('A dispute reason is required.');
      if (parts?.[2]) command.until = z.iso.date().parse(parts[2]);
      break;
    }
    case 'assign':
      command.assignee = /^@([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(reason)?.[1];
      if (!command.assignee) throw new CommandError('Use /assign @login.');
      break;
    case 'severity':
      command.severity = z
        .enum(['critical', 'high', 'medium', 'low', 'info'])
        .parse(reason);
      break;
    case 'due':
      command.due = z.iso.date().parse(reason);
      break;
    case 'ai':
      command.aiMode = z
        .enum(['triage', 'remediate', 'test-plan', 'summarize'])
        .parse(reason);
      break;
    case 'validate':
    case 'confirm':
    case 'copilot':
      break;
  }
  return commandSchema.parse(command);
}

export function parseAgentMarker(body: string): string | undefined {
  if (!body.includes('<!-- pronoia:agent')) return undefined;
  const matches = [...body.matchAll(/<!-- pronoia:agent (.*?) -->/gs)];
  if (matches.length !== 1)
    throw new CommandError('Malformed or duplicate agent marker.');
  const match = matches[0];
  if (!match?.[1]) throw new CommandError('Malformed agent marker.');
  return z
    .object({ agent: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/) })
    .strict()
    .parse(JSON.parse(match[1])).agent;
}

export function readAudit(body: string, login: string): Audit | null {
  if (!isAuditWriter(login)) {
    return null;
  }
  const match = /<!-- pronoia:transition (.*?) -->/s.exec(body);
  if (!match?.[1]) return null;
  return auditSchema.parse(JSON.parse(match[1]));
}

export function authorize(
  command: Command,
  actor: Actor,
  config: Config,
): void {
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(actor.association)) {
    throw new CommandError(
      'Only an owner, member or collaborator may use commands.',
    );
  }
  if (
    actorType(actor, config) !== 'human' &&
    !agentCommands.has(command.name)
  ) {
    throw new CommandError('This command is human-only.');
  }
}

export function nextState(
  input: WorkflowState,
  parsed: Command,
  actor: Actor,
  config: Config,
  at: string,
): WorkflowState {
  const state = stateSchema.parse(input);
  const command = commandSchema.parse(parsed);
  z.iso.datetime().parse(at);
  authorize(command, actor, config);
  if (!fromStatuses[command.name].includes(state.status)) {
    throw new CommandError(
      `/${command.name} is not allowed from ${state.status}. Allowed: ${allowedCommands(
        state.status,
        actor,
        config,
      )
        .map((name) => `/${name}`)
        .join(', ')}.`,
    );
  }
  if (
    ['reject', 'block', 'reopen', 'dispute'].includes(command.name) &&
    !command.reason.trim()
  ) {
    throw new CommandError('A reason is required.');
  }
  const result = { ...state };
  switch (command.name) {
    case 'start':
      result.status = 'in-progress';
      result.blocked_reason = null;
      result.previous_status = null;
      if (!result.assignees.length) result.assignees = [actor.login];
      break;
    case 'validate':
    case 'dispute':
      if (command.name === 'dispute') {
        if (!command.disputeType)
          throw new CommandError('A dispute type is required.');
        if (command.disputeType === 'risk-accepted') {
          if (!command.until || command.until <= dateInWib(at)) {
            throw new CommandError(
              'Risk acceptance requires a future until=YYYY-MM-DD.',
            );
          }
        } else if (command.until) {
          throw new CommandError('Only risk acceptance uses an expiry date.');
        }
        result.pending_dispute = command.disputeType;
        result.dispute_type = command.disputeType;
        result.dispute_reason = command.reason;
        result.disputed_by = actor.login;
        result.risk_until = command.until ?? null;
      }
      result.status = 'validate';
      result.validation_requested_by = actor.login;
      result.validation_requested_at = at;
      result.blocked_reason = null;
      result.previous_status = null;
      break;
    case 'approve': {
      if (
        config.governance.approvers &&
        !config.governance.approvers.some(
          (login) => login.toLowerCase() === actor.login.toLowerCase(),
        )
      ) {
        throw new CommandError('This user is not in the approver allowlist.');
      }
      if (!state.validation_requested_by) {
        throw new CommandError(
          'A validation requester must be recorded before approval.',
        );
      }
      if (
        state.pending_dispute === 'risk-accepted' &&
        (!state.risk_until || state.risk_until < dateInWib(at))
      ) {
        throw new CommandError(
          'This risk acceptance has expired; request a new dispute review.',
        );
      }
      const involved = [
        state.validation_requested_by,
        ...state.assignees,
        ...state.pr_authors,
      ].map((login) => login.toLowerCase());
      if (involved.includes(actor.login.toLowerCase())) {
        throw new CommandError(
          'Four-eyes: a different, uninvolved human must approve.',
        );
      }
      if (
        state.evidence_required &&
        state.evidence_count < 1 &&
        !(state.has_merged_pr && state.alert_fixed)
      ) {
        throw new CommandError(
          'Approval requires evidence, or a merged PR plus a fixed alert.',
        );
      }
      result.status = 'done';
      result.resolution = state.pending_dispute ?? 'fixed';
      result.pending_dispute = null;
      result.validated_by = actor.login;
      result.validated_by_name = command.validatedBy || actor.login;
      result.validated_at = at;
      break;
    }
    case 'reject':
      result.status = 'in-progress';
      result.reject_count += 1;
      result.last_reject_reason = command.reason;
      result.last_reject_by = actor.login;
      result.pending_dispute = null;
      result.dispute_type = null;
      result.dispute_reason = null;
      result.disputed_by = null;
      result.risk_until = null;
      result.validation_requested_by = null;
      result.validation_requested_at = null;
      break;
    case 'block':
      result.previous_status = state.status;
      result.status = 'blocked';
      result.blocked_reason = command.reason;
      break;
    case 'unblock':
      if (
        !state.previous_status ||
        ['blocked', 'done'].includes(state.previous_status)
      ) {
        throw new CommandError(
          'The previous open status is missing or invalid.',
        );
      }
      result.status = state.previous_status;
      result.previous_status = null;
      result.blocked_reason = null;
      break;
    case 'reopen':
      result.status = 'in-progress';
      result.resolution = null;
      result.validated_by = null;
      result.validated_by_name = null;
      result.validated_at = null;
      result.validation_requested_by = null;
      result.validation_requested_at = null;
      result.risk_until = null;
      break;
    case 'confirm':
      result.confirmed_by = actor.login;
      break;
    case 'assign':
      if (!command.assignee) throw new CommandError('An assignee is required.');
      result.assignees = [command.assignee];
      break;
    case 'severity':
      if (!command.severity) throw new CommandError('A severity is required.');
      result.severity = command.severity;
      break;
    case 'due':
      if (!command.due) throw new CommandError('A due date is required.');
      result.due_date = command.due;
      break;
    case 'copilot':
      result.status = 'in-progress';
      break;
    case 'ai':
      break;
  }
  return stateSchema.parse(result);
}
