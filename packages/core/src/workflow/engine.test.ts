import { describe, expect, it } from 'vitest';
import {
  actorType,
  allowedCommands,
  nextState,
  parseAgentMarker,
  parseCommand,
  readAudit,
} from './engine.js';
import { configSchema } from '../config.js';
import { marker } from '../assessment.js';
import {
  stateSchema,
  type Actor,
  type Command,
  type Status,
} from './schemas.js';

const config = configSchema.parse({});
const actor: Actor = {
  login: 'reviewer',
  association: 'COLLABORATOR',
  userType: 'User',
};
const at = '2026-11-20T12:00:00.000Z';
const statuses: Status[] = [
  'todo',
  'in-progress',
  'validate',
  'blocked',
  'done',
];
const rows: [Command, Status[], Status | 'previous' | 'same'][] = [
  [
    { name: 'start', reason: '', validatedBy: '' },
    ['todo', 'blocked'],
    'in-progress',
  ],
  [
    { name: 'validate', reason: 'tested', validatedBy: '' },
    ['todo', 'in-progress', 'blocked'],
    'validate',
  ],
  [{ name: 'approve', reason: '', validatedBy: '' }, ['validate'], 'done'],
  [
    { name: 'reject', reason: 'expected differs', validatedBy: '' },
    ['validate'],
    'in-progress',
  ],
  [
    {
      name: 'dispute',
      reason: 'unused package',
      validatedBy: '',
      disputeType: 'false-positive',
    },
    ['todo', 'in-progress', 'blocked'],
    'validate',
  ],
  [
    { name: 'block', reason: 'needs access', validatedBy: '' },
    ['todo', 'in-progress', 'validate'],
    'blocked',
  ],
  [{ name: 'unblock', reason: '', validatedBy: '' }, ['blocked'], 'previous'],
  [
    { name: 'reopen', reason: 'finding returned', validatedBy: '' },
    ['done'],
    'in-progress',
  ],
  [
    { name: 'confirm', reason: '', validatedBy: '' },
    ['todo', 'in-progress', 'validate', 'blocked'],
    'same',
  ],
  [
    { name: 'assign', reason: '@worker', validatedBy: '', assignee: 'worker' },
    statuses,
    'same',
  ],
  [
    { name: 'severity', reason: 'high', validatedBy: '', severity: 'high' },
    statuses,
    'same',
  ],
  [
    { name: 'due', reason: '2026-12-01', validatedBy: '', due: '2026-12-01' },
    statuses,
    'same',
  ],
  [
    { name: 'copilot', reason: 'Add a regression test', validatedBy: '' },
    ['todo', 'in-progress'],
    'in-progress',
  ],
  [
    { name: 'ai', reason: 'triage', validatedBy: '', aiMode: 'triage' },
    statuses,
    'same',
  ],
];

describe('command grammar', () => {
  it('uses only the first line, case-insensitively, with optional on-behalf-of', () => {
    expect(parseCommand('/VaLiDaTe verified\nExpected: green')).toMatchObject({
      name: 'validate',
      reason: 'verified',
    });
    expect(
      parseCommand('/APPROVE\nValidated-by: Contoso test reviewer'),
    ).toMatchObject({
      name: 'approve',
      validatedBy: 'Contoso test reviewer',
    });
    expect(parseCommand('ordinary note\n/approve')).toBeNull();
    expect(parseCommand(' /approve')).toBeNull();
  });

  it.each(['/reject', '/block', '/reopen', '/dispute false-positive'])(
    'refuses missing reason: %s',
    (body) => expect(() => parseCommand(body)).toThrow(/reason/i),
  );

  it.each([
    '/approve someone',
    '/start /approve',
    '/due 2026-02-30',
    '/severity urgent',
    '/assign not-a-mention',
    '/ai approve',
    '/dispute invented reason',
    '/unknown',
  ])('refuses malformed or unknown input: %s', (body) => {
    expect(() => parseCommand(body)).toThrow();
  });

  it('parses metadata commands without treating body text as instructions', () => {
    expect(parseCommand('/assign @worker')).toMatchObject({
      assignee: 'worker',
    });
    expect(parseCommand('/severity high')).toMatchObject({ severity: 'high' });
    expect(parseCommand('/due 2026-12-01')).toMatchObject({
      due: '2026-12-01',
    });
    expect(
      parseCommand(
        '/dispute risk-accepted until=2026-12-01 temporary exception',
      ),
    ).toMatchObject({ disputeType: 'risk-accepted', until: '2026-12-01' });
  });
});

describe('state table', () => {
  for (const [command, from, expected] of rows) {
    for (const status of statuses) {
      it(`${command.name} from ${status}`, () => {
        const state = stateSchema.parse({
          status,
          validation_requested_by: 'requester',
          evidence_count: 1,
          previous_status: 'validate',
        });
        if (from.includes(status)) {
          const result = nextState(state, command, actor, config, at);
          expect(result.status).toBe(
            expected === 'same'
              ? status
              : expected === 'previous'
                ? 'validate'
                : expected,
          );
        } else {
          expect(() => nextState(state, command, actor, config, at)).toThrow(
            /allowed/i,
          );
        }
      });
    }
  }
});

describe('authorization and four-eyes', () => {
  const validate = stateSchema.parse({
    status: 'validate',
    validation_requested_by: 'requester',
    assignees: ['worker'],
    pr_authors: ['fixer'],
    evidence_count: 1,
  });
  const approve = parseCommand('/approve\nValidated-by: External validator');
  if (!approve) throw new Error('Fixture command missing');

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIMER'])(
    'refuses association %s',
    (association) => {
      expect(() =>
        nextState(validate, approve, { ...actor, association }, config, at),
      ).toThrow(/collaborator|member|owner/i);
    },
  );

  it.each(['requester', 'worker', 'fixer'])(
    'refuses self approval by %s',
    (login) => {
      expect(() =>
        nextState(validate, approve, { ...actor, login }, config, at),
      ).toThrow(/four-eyes/i);
    },
  );

  it('does not let Validated-by bypass GitHub identity', () => {
    expect(() =>
      nextState(
        validate,
        approve,
        { ...actor, login: 'requester' },
        config,
        at,
      ),
    ).toThrow(/four-eyes/i);
    const result = nextState(validate, approve, actor, config, at);
    expect(result.validated_by).toBe('reviewer');
    expect(result.validated_by_name).toBe('External validator');
  });

  it.each([
    { login: 'bot[bot]', userType: 'Bot' as const },
    { login: 'machine', userType: 'User' as const, agent: 'scout' },
    { login: 'automation', userType: 'User' as const },
  ])('refuses human-only commands by $login', (identity) => {
    const configured = configSchema.parse({
      governance: { automation_logins: ['automation'] },
    });
    for (const body of [
      '/approve',
      '/reject reason',
      '/dispute false-positive reason',
      '/confirm',
      '/assign @worker',
      '/unblock',
    ]) {
      const command = parseCommand(body);
      if (!command) throw new Error('Fixture command missing');
      expect(() =>
        nextState(validate, command, { ...actor, ...identity }, configured, at),
      ).toThrow(/human/i);
    }
  });

  it('requires a known validation requester and verified evidence', () => {
    expect(() =>
      nextState(
        { ...validate, validation_requested_by: null },
        approve,
        actor,
        config,
        at,
      ),
    ).toThrow(/requester/i);
    expect(() =>
      nextState({ ...validate, evidence_count: 0 }, approve, actor, config, at),
    ).toThrow(/evidence/i);
    expect(
      nextState(
        { ...validate, evidence_count: 0, evidence_required: false },
        approve,
        actor,
        config,
        at,
      ).status,
    ).toBe('done');
  });

  it('accepts automated evidence only when both merged PR and fixed alert are proved', () => {
    for (const has_merged_pr of [false, true]) {
      for (const alert_fixed of [false, true]) {
        const state = {
          ...validate,
          evidence_count: 0,
          has_merged_pr,
          alert_fixed,
        };
        if (has_merged_pr && alert_fixed) {
          expect(nextState(state, approve, actor, config, at).status).toBe(
            'done',
          );
        } else {
          expect(() => nextState(state, approve, actor, config, at)).toThrow(
            /evidence/i,
          );
        }
      }
    }
  });

  it('enforces a configured approver allowlist', () => {
    const configured = configSchema.parse({
      governance: { approvers: ['other'] },
    });
    expect(() => nextState(validate, approve, actor, configured, at)).toThrow(
      /approver/i,
    );
  });

  it('does not permit disabling the mandatory four-eyes policy', () => {
    expect(() =>
      configSchema.parse({
        governance: { allow_self_approve: true },
      }),
    ).toThrow();
  });
});

describe('audit and governance data', () => {
  it('records rejection and preserves unblock state', () => {
    const state = stateSchema.parse({
      status: 'validate',
      pending_dispute: 'false-positive',
      validation_requested_by: 'requester',
    });
    const reject = parseCommand('/reject missing screenshot');
    const block = parseCommand('/block access denied');
    const unblock = parseCommand('/unblock');
    if (!reject || !block || !unblock)
      throw new Error('Fixture command missing');
    const rejected = nextState(state, reject, actor, config, at);
    expect(rejected.reject_count).toBe(1);
    expect(rejected.pending_dispute).toBeNull();
    expect(rejected.last_reject_by).toBe(actor.login);
    const blocked = nextState(rejected, block, actor, config, at);
    expect(blocked.previous_status).toBe('in-progress');
    expect(nextState(blocked, unblock, actor, config, at).status).toBe(
      'in-progress',
    );
    expect(() =>
      nextState(
        { ...blocked, previous_status: null },
        unblock,
        actor,
        config,
        at,
      ),
    ).toThrow(/previous/i);
  });

  it('requires a future expiry for risk acceptance and a second reviewer for disputes', () => {
    const state = stateSchema.parse({ evidence_count: 1 });
    for (const body of [
      '/dispute risk-accepted reason',
      '/dispute risk-accepted until=2026-11-19 reason',
    ]) {
      const command = parseCommand(body);
      if (!command) throw new Error('Fixture command missing');
      expect(() => nextState(state, command, actor, config, at)).toThrow(
        /future|until/i,
      );
    }
    const dispute = parseCommand(
      '/dispute risk-accepted until=2026-12-01 time-limited',
    );
    const approve = parseCommand('/approve');
    if (!dispute || !approve) throw new Error('Fixture command missing');
    const pending = nextState(state, dispute, actor, config, at);
    expect(() => nextState(pending, approve, actor, config, at)).toThrow(
      /four-eyes/i,
    );
    expect(
      nextState(pending, approve, { ...actor, login: 'second' }, config, at)
        .resolution,
    ).toBe('risk-accepted');
  });

  it('recognizes agent identities fail-closed', () => {
    expect(
      parseAgentMarker('/start\n<!-- pronoia:agent {"agent":"scout"} -->'),
    ).toBe('scout');
    expect(parseAgentMarker('/start')).toBeUndefined();
    expect(() =>
      parseAgentMarker('/approve\n<!-- pronoia:agent nope -->'),
    ).toThrow();
    expect(actorType({ ...actor, agent: 'scout' }, config)).toBe('agent');
    expect(actorType({ ...actor, login: 'github-actions[bot]' }, config)).toBe(
      'automation',
    );
    expect(
      allowedCommands('todo', { ...actor, agent: 'scout' }, config),
    ).toEqual(['start', 'validate', 'block']);
  });

  it('compares configured automation identities case-insensitively', () => {
    const configured = configSchema.parse({
      governance: { automation_logins: ['MaChInE'] },
    });
    expect(actorType({ ...actor, login: 'machine' }, configured)).toBe(
      'automation',
    );
    const approve = parseCommand('/approve');
    if (!approve) throw new Error('Fixture command missing');
    expect(() =>
      nextState(
        stateSchema.parse({
          status: 'validate',
          evidence_count: 1,
          validation_requested_by: 'requester',
        }),
        approve,
        { ...actor, login: 'machine' },
        configured,
        at,
      ),
    ).toThrow(/human/i);
  });

  it('ignores forged audit markers from humans', () => {
    const body = '<!-- pronoia:transition {"from":"todo","to":"done"} -->';
    expect(readAudit(body, 'reviewer')).toBeNull();
    expect(() => readAudit(body, 'github-actions[bot]')).toThrow();
  });

  it('classifies automation without trusting its fabricated status audits', () => {
    const configured = configSchema.parse({
      governance: { automation_logins: ['machine'] },
    });
    const fake = {
      from: 'validate',
      to: 'done',
      command: { name: 'approve', reason: '', validatedBy: '' },
      actor: 'machine',
      actor_type: 'automation',
      on_behalf_of: '',
      reason: '',
      evidence_count: 0,
      at,
      comment_id: 10,
      state: stateSchema.parse({ status: 'done' }),
    };
    expect(actorType({ ...actor, login: 'machine' }, configured)).toBe(
      'automation',
    );
    expect(readAudit(marker('transition', fake), 'machine')).toBeNull();
  });

  it('refuses a risk acceptance that expired while waiting for approval', () => {
    const command = parseCommand('/approve');
    if (!command) throw new Error('Fixture command missing');
    const pending = stateSchema.parse({
      status: 'validate',
      pending_dispute: 'risk-accepted',
      risk_until: '2026-11-21',
      evidence_count: 1,
      validation_requested_by: 'requester',
    });
    expect(() =>
      nextState(pending, command, actor, config, '2026-11-22T12:00:00.000Z'),
    ).toThrow(/expired/i);
  });
});
