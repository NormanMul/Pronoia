import { expect, it } from 'vitest';
import {
  configSchema,
  issueBody,
  marker,
  stateSchema,
  type Issue,
  type IssueComment,
} from '@pronoia/core';
import { buildItemDetail } from './item-detail';

const at = '2026-11-20T12:00:00Z';
const issue: Issue = {
  number: 2,
  title: 'Synthetic MFA',
  body: issueBody(
    {
      test_id: 'MFA',
      title: 'Synthetic MFA',
      category: 'Identity',
      description: 'Confirm MFA.',
      procedure: 'Sign in to synthetic account.',
      expected_result: 'MFA challenge.',
      severity: 'high',
      evidence_required: true,
      owner_role: 'Tester',
      references: '',
    },
    'Contoso',
    true,
  ),
  labels: ['pronoia', 'status:todo'],
  assignees: [],
  state: 'open',
  html_url: 'https://github.com/Contoso/demo/issues/2',
  created_at: at,
  updated_at: at,
};
const comment = (id: number, body: string, login: string): IssueComment => ({
  id,
  body,
  user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  author_association: 'COLLABORATOR',
  created_at: at,
  html_url: `https://github.com/Contoso/demo/issues/2#issuecomment-${id}`,
});

it('shows test documentation and only canonical Actions validation records as audit trail', () => {
  const audit = {
    from: 'todo',
    to: 'validate',
    command: { name: 'validate', reason: 'MFA observed.', validatedBy: '' },
    actor: 'requester',
    actor_type: 'human',
    on_behalf_of: '',
    reason: 'MFA observed.',
    evidence_count: 0,
    at,
    comment_id: 1,
    state: stateSchema.parse({
      status: 'validate',
      validation_requested_by: 'requester',
    }),
  };
  const detail = buildItemDetail(
    issue,
    [
      comment(1, '/validate MFA observed.', 'requester'),
      comment(2, marker('transition', audit), 'external[bot]'),
      comment(3, marker('transition', audit), 'github-actions[bot]'),
    ],
    configSchema.parse({ board_repo: 'Contoso/demo' }),
  );
  expect(detail.test).toBe('Confirm MFA.');
  expect(detail.expected).toBe('MFA challenge.');
  expect(detail.comments).toHaveLength(3);
  expect(detail.trail).toHaveLength(1);
  expect(detail.card.status).toBe('validate');
});

it('does not expose cross-item or untrusted evidence and explicitly reports malformed markers', () => {
  const meta = {
    file: 'evidence/2/20261120T120000Z-aaaaaaaa.png',
    sha256: 'a'.repeat(64),
    captured_at: at,
    captured_by: 'tester',
    source: 'Synthetic screen',
    session: 's',
    step: 'Confirm MFA',
    note: 'Synthetic.',
  };
  const unauthorized = {
    ...comment(2, marker('evidence', meta), 'outsider'),
    author_association: 'NONE',
  };
  const detail = buildItemDetail(
    issue,
    [
      comment(1, marker('evidence', meta), 'tester'),
      unauthorized,
      comment(
        3,
        marker('evidence', {
          ...meta,
          file: 'evidence/3/20261120T120000Z-aaaaaaaa.png',
        }),
        'tester',
      ),
      comment(4, '<!-- pronoia:evidence {"broken":true} -->', 'tester'),
    ],
    configSchema.parse({ board_repo: 'Contoso/demo' }),
  );
  expect(detail.evidence).toHaveLength(1);
  expect(detail.evidence[0]?.step).toBe('Confirm MFA');
  expect(detail.warnings.length).toBeGreaterThan(0);
});
