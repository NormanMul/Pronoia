import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Octokit } from 'octokit';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Board, issueSchema, type IssueComment } from '../github.js';
import { configSchema } from '../config.js';
import { marker, metaSchema } from '../assessment.js';
import {
  FoundryService,
  createFoundryClient,
  foundryConfig,
} from '../ai/foundry.js';
import { queueManualAi } from '../ai/commands.js';
import { SecurityAlerts } from './alerts.js';
import { queueMergeIntents, consumeIssueIntents } from './intents.js';

const repo = 'NormanMul/Pronoia';
const eventFiles: string[] = [];
beforeAll(() => {
  fixture();
}, 30000);
afterEach(() => {
  vi.unstubAllEnvs();
  eventFiles.splice(0).forEach((file) => rmSync(file, { force: true }));
});

function event(kind: string, sender = 'requester') {
  const file = resolve(`.m2-review-event-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({ sender: { login: sender }, pull_request: { number: 9 } }),
  );
  eventFiles.push(file);
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_EVENT_NAME', kind);
  vi.stubEnv('GITHUB_EVENT_PATH', file);
  vi.stubEnv('GITHUB_RUN_ID', '900');
}

function fixture() {
  const api = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(api, configSchema.parse({ board_repo: repo }));
  const issue = issueSchema.parse({
    number: 1,
    title: 'Synthetic review',
    body: marker(
      'meta',
      metaSchema.parse({
        source: 'checklist',
        assessment: 'Synthetic',
        test_id: 'one',
        dedupe_key: 'checklist/synthetic/one',
        synthetic: true,
      }),
    ),
    labels: ['pronoia', 'status:todo'],
    assignees: [],
    state: 'open',
    html_url: `https://github.com/${repo}/issues/1`,
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  });
  const comments: IssueComment[] = [];
  vi.spyOn(board, 'issue').mockImplementation(async () => issue);
  vi.spyOn(board, 'issues').mockResolvedValue([issue]);
  vi.spyOn(board, 'comments').mockImplementation(async () => comments);
  vi.spyOn(board, 'applyCommands').mockImplementation(async () => {
    if (comments.some((comment) => comment.body.startsWith('/validate')))
      issue.labels = ['pronoia', 'status:validate'];
    return { accepted: 0, rejected: 0 };
  });
  vi.spyOn(board, 'setupLabels').mockResolvedValue();
  vi.spyOn(api.rest.issues, 'addLabels').mockResolvedValue(
    {} as Awaited<ReturnType<typeof api.rest.issues.addLabels>>,
  );
  let failResult = false;
  const post = vi
    .spyOn(board, 'comment')
    .mockImplementation(async (_number, body) => {
      if (failResult && body.includes('pronoia:intent-result')) {
        failResult = false;
        throw new Error('interrupted result write');
      }
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
  vi.spyOn(api.rest.users, 'getByUsername').mockImplementation(
    async (params) =>
      ({
        data: { login: params?.username ?? 'requester', type: 'User' },
      }) as Awaited<ReturnType<typeof api.rest.users.getByUsername>>,
  );
  vi.spyOn(api.rest.repos, 'getCollaboratorPermissionLevel').mockResolvedValue({
    data: { permission: 'write' },
  } as Awaited<
    ReturnType<typeof api.rest.repos.getCollaboratorPermissionLevel>
  >);
  vi.spyOn(api.rest.pulls, 'get').mockResolvedValue({
    data: {
      title: 'Refs #1',
      body: '',
      merged_at: '2026-11-20T12:00:00Z',
      base: { repo: { full_name: repo } },
      head: { repo: { full_name: repo } },
    },
  } as Awaited<ReturnType<typeof api.rest.pulls.get>>);
  const cfg = foundryConfig({
    AZURE_AUTH_MODE: 'key',
    AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.openai.azure.com',
    AZURE_FOUNDRY_API_KEY: 'test-only-key',
    FOUNDRY_CHAT_DEPLOYMENT: 'fixture',
  });
  if (!cfg.ok) throw new Error('Missing fixture');
  const foundry = new FoundryService(createFoundryClient(cfg.value), cfg.value);
  const call = vi.spyOn(foundry, 'call').mockResolvedValue({
    ok: true,
    value: {
      summary: 'Synthetic',
      priority: 'p2',
      reason: 'Review',
      remediation: [],
      references: [],
      confidence: 0.8,
    },
    usage: null,
    warnings: [],
  });
  board.integrations.foundry = foundry;
  return {
    board,
    alerts: new SecurityAlerts(api),
    comments,
    issue,
    post,
    call,
    failOnce: () => {
      failResult = true;
    },
  };
}

it('lets an ordinary surviving worker complete persisted merge work even after its dispatch was replaced', async () => {
  const f = fixture();
  event('pull_request');
  await queueMergeIntents(f.board, 9);
  expect(
    f.comments.some((comment) => comment.body.includes('pronoia:merge-intent')),
  ).toBe(true);
  event('issue_comment', 'other-human');
  await consumeIssueIntents(f.board, f.alerts, 1);
  await consumeIssueIntents(f.board, f.alerts, 1);
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/validate')),
  ).toHaveLength(1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:merge-proof'),
    ),
  ).toHaveLength(1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:intent-result'),
    ),
  ).toHaveLength(1);
});

it('retains the authenticated manual-AI requester and generates once in a different surviving worker', async () => {
  const f = fixture();
  event('workflow_dispatch', 'original-requester');
  await queueManualAi(f.board, 1, 'triage');
  event('issue_comment', 'other-human');
  await consumeIssueIntents(f.board, f.alerts, 1);
  await consumeIssueIntents(f.board, f.alerts, 1);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:ai-proposal'),
    ),
  ).toHaveLength(1);
  expect(
    f.comments.find((comment) => comment.body.includes('pronoia:ai-request'))
      ?.body,
  ).toContain('original-requester');
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/')),
  ).toHaveLength(0);
});

it('recovers completed side effects when persisting the intent completion failed', async () => {
  const f = fixture();
  event('workflow_dispatch');
  await queueManualAi(f.board, 1, 'triage');
  f.failOnce();
  await expect(consumeIssueIntents(f.board, f.alerts, 1)).rejects.toThrow(
    'interrupted result write',
  );
  await consumeIssueIntents(f.board, f.alerts, 1);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:ai-proposal'),
    ),
  ).toHaveLength(1);
});

it('does not consume human or configured-agent forged intent markers', async () => {
  const f = fixture();
  f.comments.push({
    id: 1,
    body: marker('merge-intent', {
      issue: 1,
      pull: 9,
      requester: 'owner',
      run_id: 1,
    }),
    user: { login: 'untrusted', type: 'User' },
    author_association: 'OWNER',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${repo}/issues/1#forged`,
  });
  await consumeIssueIntents(f.board, f.alerts, 1);
  expect(f.post).not.toHaveBeenCalled();
  expect(f.call).not.toHaveBeenCalled();
});
