import { readFileSync } from 'node:fs';
import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { Board, issueSchema, type IssueComment } from '../github.js';
import { configSchema } from '../config.js';
import { marker, metaSchema, readMeta } from '../assessment.js';
import { auditSchema, stateSchema } from '../workflow/schemas.js';
import {
  ingestDependabot,
  ingestCodeScanning,
  ingestSecretScanning,
  ingestSarif,
} from './findings.js';

const repo = 'NormanMul/Pronoia';
function sample(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../samples/security/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}
const findings = [
  ...ingestDependabot(sample('dependabot'), repo).slice(0, 1),
  ...ingestCodeScanning(sample('code-scanning'), repo),
  ...ingestSecretScanning(sample('secret-scanning'), repo).slice(0, 1),
  ...ingestSarif(sample('sarif'), repo),
];

function fixture(
  source: 'checklist' | (typeof findings)[number]['source'],
  finding = findings.find((item) => item.source === source),
) {
  const meta = metaSchema.parse({
    source,
    dedupe_key: finding?.key ?? 'checklist/synthetic/one',
    assessment: 'Synthetic policy',
    test_id: 'one',
    evidence_required: false,
    synthetic: true,
    ...(finding ? { finding } : {}),
  });
  const issue = issueSchema.parse({
    number: 1,
    title: finding?.title ?? 'Synthetic checklist',
    body: marker('meta', { ...meta, evidence_required: false }),
    labels: ['pronoia', 'status:todo', `source:${source}`],
    assignees: [],
    state: 'open',
    html_url: `https://github.com/${repo}/issues/1`,
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  });
  const comments: IssueComment[] = [];
  const api = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(api, configSchema.parse({ board_repo: repo }));
  vi.spyOn(board, 'guard').mockResolvedValue();
  vi.spyOn(board, 'issue').mockImplementation(async () => issue);
  vi.spyOn(board, 'comments').mockImplementation(async () => comments);
  vi.spyOn(board, 'approvalContext').mockImplementation(
    async (_issue, state) => ({
      ...state,
      evidence_count: 0,
      has_merged_pr: false,
      alert_fixed: false,
    }),
  );
  vi.spyOn(board, 'reconcile').mockImplementation(async (_issue, state) => {
    issue.labels = ['pronoia', `source:${source}`, `status:${state.status}`];
    issue.state = state.status === 'done' ? 'closed' : 'open';
  });
  vi.spyOn(api.rest.reactions, 'createForIssueComment').mockResolvedValue(
    {} as Awaited<ReturnType<typeof api.rest.reactions.createForIssueComment>>,
  );
  vi.spyOn(api.rest.issues, 'updateComment').mockImplementation(
    async (params) => {
      const comment = comments.find((item) => item.id === params?.comment_id);
      if (!comment) throw new Error('Missing synthetic comment');
      comment.body = params?.body ?? '';
      return {} as Awaited<ReturnType<typeof api.rest.issues.updateComment>>;
    },
  );
  vi.spyOn(board, 'comment').mockImplementation(async (_number, body) => {
    const comment: IssueComment = {
      id: comments.length + 100,
      body,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      author_association: 'NONE',
      created_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/${repo}/issues/1#comment`,
    };
    comments.push(comment);
    return comment;
  });
  const command = (body: string, login: string) =>
    comments.push({
      id: comments.length + 1,
      body,
      user: { login, type: 'User' },
      author_association: 'COLLABORATOR',
      created_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/${repo}/issues/1#command`,
    });
  return { board, issue, comments, command };
}

it.each(findings)(
  'refuses a synthetic $source waiver without evidence or real merged-fixed proof',
  async (finding) => {
    const f = fixture(finding.source, finding);
    f.command('/validate synthetic check', 'worker');
    f.command('/approve', 'independent');
    expect(await f.board.applyCommands(1)).toEqual({
      accepted: 1,
      rejected: 1,
    });
    expect(f.issue.state).toBe('open');
    expect(f.issue.labels).toContain('status:validate');
    expect(readMeta(f.issue.body)?.evidence_required).toBe(true);
  },
);

it.each(findings)(
  'forces $source evidence after overlaying a trusted journal with a stale waiver',
  async (finding) => {
    const f = fixture(finding.source, finding);
    f.comments.push({
      id: 10,
      body:
        marker(
          'transition',
          auditSchema.parse({
            from: 'todo',
            to: 'validate',
            command: { name: 'validate' },
            actor: 'worker',
            actor_type: 'human',
            on_behalf_of: '',
            reason: '',
            evidence_count: 0,
            at: '2026-11-20T12:00:00Z',
            comment_id: 9,
            state: stateSchema.parse({
              status: 'validate',
              evidence_required: false,
              validation_requested_by: 'worker',
            }),
          }),
        ) +
        '\n' +
        marker('command-result', { comment_id: 9, accepted: true }),
      user: { login: 'github-actions[bot]', type: 'Bot' },
      author_association: 'NONE',
      created_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/${repo}/issues/1#audit`,
    });
    f.command('/approve', 'independent');
    expect(await f.board.applyCommands(1)).toEqual({
      accepted: 0,
      rejected: 1,
    });
    expect(f.issue.state).toBe('open');
  },
);

it('retains the explicitly approved checklist per-test evidence waiver', async () => {
  const f = fixture('checklist');
  f.command('/validate synthetic checklist', 'worker');
  f.command('/approve', 'independent');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 2, rejected: 0 });
  expect(f.issue.state).toBe('closed');
});
