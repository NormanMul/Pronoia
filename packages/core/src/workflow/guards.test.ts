import { expect, it } from 'vitest';
import { expectedState, guardPlan } from './guards.js';
import { configSchema } from '../config.js';
import { marker } from '../assessment.js';
import { stateSchema } from './schemas.js';

const config = configSchema.parse({});
const issue = {
  number: 1,
  labels: ['pronoia', 'status:todo'],
  assignees: [],
  body: '',
  state: 'open' as const,
};
const audit = {
  from: 'todo',
  to: 'validate',
  command: { name: 'validate', reason: '', validatedBy: '' },
  actor: 'requester',
  actor_type: 'human',
  on_behalf_of: '',
  reason: '',
  evidence_count: 0,
  at: '2026-11-20T12:00:00.000Z',
  comment_id: 1,
  state: stateSchema.parse({
    status: 'validate',
    validation_requested_by: 'requester',
  }),
};

it('restores the latest trusted audited status, never a forged human audit', () => {
  const comments = [
    {
      body: marker('transition', audit),
      user: { login: 'github-actions[bot]' },
    },
    {
      body: marker('transition', {
        ...audit,
        to: 'done',
        state: stateSchema.parse({ status: 'done' }),
      }),
      user: { login: 'attacker' },
    },
  ];
  expect(expectedState(issue, comments, config).status).toBe('validate');
  expect(
    guardPlan(
      { ...issue, labels: ['pronoia', 'status:done'], state: 'closed' },
      comments,
      config,
    ),
  ).toMatchObject({ status: 'validate', reopen: true, relabel: true });
});

it('accepts initial todo only and reopens unauthorized closures', () => {
  expect(guardPlan(issue, [], config)).toMatchObject({
    relabel: false,
    reopen: false,
  });

  expect(
    guardPlan({ ...issue, labels: ['pronoia', 'status:done'] }, [], config)
      .status,
  ).toBe('todo');
  expect(guardPlan({ ...issue, state: 'closed' }, [], config).reopen).toBe(
    true,
  );
  expect(
    guardPlan(
      { ...issue, labels: ['pronoia', 'status:todo', 'status:done'] },
      [],
      config,
    ).relabel,
  ).toBe(true);
});

it('recloses an approved issue reopened without an audited reopen command', () => {
  const approved = {
    ...audit,
    from: 'validate',
    to: 'done',
    command: { name: 'approve', reason: '', validatedBy: '' },
    state: stateSchema.parse({ status: 'done' }),
  };
  expect(
    guardPlan(
      { ...issue, labels: ['pronoia', 'status:done'] },
      [
        {
          body: marker('transition', approved),
          user: { login: 'github-actions[bot]' },
        },
      ],
      config,
    ),
  ).toMatchObject({ close: true });
});
