import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Octokit } from 'octokit';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Board,
  configSchema,
  marker,
  metaSchema,
  type IssueComment,
  issueSchema,
  Enricher,
} from '@pronoia/core';
import { registerM2Commands, targetReadCredential } from './security.js';

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_TOKEN', 'test-only-board');
  const config = configSchema.parse({
    board_repo: 'NormanMul/Pronoia',
    targets: [
      {
        repo: 'Fabrikam/external',
        assessment: 'Synthetic external',
        synthetic: true,
      },
    ],
  });
  const api = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(api, config);
  vi.spyOn(board, 'isPublic').mockResolvedValue(true);
  const repos = vi
    .spyOn(api.rest.repos, 'get')
    .mockImplementation(async (params) => {
      if (params?.owner !== 'NormanMul')
        throw new Error('Board token must never read an external repo');
      return { data: { private: false } } as Awaited<
        ReturnType<typeof api.rest.repos.get>
      >;
    });
  const output = vi.fn();
  const program = new Command().exitOverride();
  registerM2Commands(program, {
    config: () => config,
    board: () => board,
    writerIssue: () => 1,
    output,
  });
  return { program, output, board, api, repos };
}

it('skips external scanner targets without READ credentials in the actual CLI path', async () => {
  const f = fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await f.program.parseAsync([
      'node',
      'cli',
      'scan-targets',
      '--check-public',
    ]);
    expect(
      f.repos.mock.calls.every(([params]) => params?.owner === 'NormanMul'),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/separate.*READ/i));
    expect(f.output).toHaveBeenCalledWith(
      expect.objectContaining({
        include: [
          expect.objectContaining({
            repo: 'NormanMul/Pronoia',
            allow_board_token: true,
          }),
        ],
      }),
    );
  } finally {
    warn.mockRestore();
  }
});

it('an ordinary CLI issue worker consumes unfinished merge intents without needing merge mode', async () => {
  const f = fixture();
  const comments: IssueComment[] = [
    {
      id: 50,
      body: marker('merge-intent', {
        issue: 1,
        pull: 9,
        requester: 'original',
        run_id: 900,
      }),
      user: { login: 'github-actions[bot]', type: 'Bot' },
      author_association: 'NONE',
      created_at: '2026-11-20T12:00:00Z',
      html_url: 'https://github.com/NormanMul/Pronoia/issues/1#intent',
    },
  ];
  const issue = issueSchema.parse({
    number: 1,
    title: 'Synthetic',
    body: marker(
      'meta',
      metaSchema.parse({
        source: 'checklist',
        synthetic: true,
        dedupe_key: 'checklist/synthetic/one',
        assessment: 'Synthetic',
        test_id: 'one',
      }),
    ),
    labels: ['pronoia', 'status:todo'],
    assignees: [],
    state: 'open',
    html_url: 'https://github.com/NormanMul/Pronoia/issues/1',
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  });
  vi.spyOn(f.board, 'issue').mockResolvedValue(issue);
  vi.spyOn(f.board, 'comments').mockImplementation(async () => comments);
  vi.spyOn(f.board, 'applyCommands').mockResolvedValue({
    accepted: 0,
    rejected: 0,
  });
  vi.spyOn(f.board, 'comment').mockImplementation(async (_number, body) => {
    const comment = {
      ...comments[0],
      id: comments.length + 100,
      body,
    } as IssueComment;
    comments.push(comment);
    return comment;
  });
  vi.spyOn(f.api.rest.pulls, 'get').mockResolvedValue({
    data: {
      title: 'Refs #1',
      body: '',
      merged_at: '2026-11-20T12:00:00Z',
      base: { repo: { full_name: 'NormanMul/Pronoia' } },
      head: { repo: { full_name: 'NormanMul/Pronoia' } },
    },
  } as Awaited<ReturnType<typeof f.api.rest.pulls.get>>);
  await f.program.parseAsync(['node', 'cli', 'process-issue', '--issue', '1']);
  expect(comments.some((comment) => comment.body.startsWith('/validate'))).toBe(
    true,
  );
  expect(f.output).toHaveBeenCalledWith(
    expect.objectContaining({
      intents: expect.objectContaining({ completed: 1 }),
    }),
  );
});

function sampleBundle(overrides: Record<string, unknown> = {}) {
  const file = resolve(`.m2-final-sample-${randomUUID()}.json`);
  const sarif: unknown = JSON.parse(
    readFileSync(
      new URL('../../../samples/security/sarif.json', import.meta.url),
      'utf8',
    ),
  );
  writeFileSync(
    file,
    JSON.stringify({
      repo: 'NormanMul/Pronoia',
      assessment: 'Synthetic vulnerable application',
      synthetic: true,
      sample: true,
      sarif,
      ...overrides,
    }),
  );
  return file;
}

it('authorizes the mandatory attested own sample even when configured targets are only external', async () => {
  const f = fixture();
  const file = sampleBundle();
  vi.spyOn(f.board, 'issues').mockResolvedValue([]);
  vi.spyOn(f.board, 'setupLabels').mockResolvedValue();
  const create = vi
    .spyOn(f.api.rest.issues, 'create')
    .mockResolvedValue({ data: { number: 1 } } as Awaited<
      ReturnType<typeof f.api.rest.issues.create>
    >);
  const enrich = vi.spyOn(Enricher.prototype, 'enrich').mockImplementation(
    async (findings) =>
      new Map(
        findings.map((finding) => [
          finding.key,
          {
            cvss: null,
            epss: null,
            epss_percentile: null,
            epss_date: null,
            kev: null,
            kev_due_date: null,
            warnings: ['Synthetic offline fixture.'],
          },
        ]),
      ),
  );
  try {
    await expect(
      f.program.parseAsync(['node', 'cli', 'ingest-sarif', file, '--bundle']),
    ).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    enrich.mockRestore();
    rmSync(file, { force: true });
  }
});

it('does not authorize arbitrary unconfigured repos through the own-sample exemption', async () => {
  const f = fixture();
  const file = sampleBundle({ repo: 'Another/unconfigured' });
  try {
    await expect(
      f.program.parseAsync(['node', 'cli', 'ingest-sarif', file, '--bundle']),
    ).rejects.toThrow(/configured|sample/i);
    expect(f.repos).not.toHaveBeenCalled();
  } finally {
    rmSync(file, { force: true });
  }
});

it.each([403, 404])(
  'scanner planning skips metadata HTTP %s and retains earlier/later eligible targets',
  async (status) => {
    const f = fixture();
    f.board.integrations.targetApi = f.api;
    f.board.config.targets = [
      'Before/repo',
      'Unavailable/repo',
      'After/repo',
    ].map((repo) => ({ repo, assessment: 'Synthetic', synthetic: true }));
    f.repos.mockImplementation(async (params) => {
      if (params?.owner === 'Unavailable')
        throw Object.assign(new Error('metadata unavailable'), { status });
      return { data: { private: false } } as Awaited<
        ReturnType<typeof f.api.rest.repos.get>
      >;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await f.program.parseAsync([
        'node',
        'cli',
        'scan-targets',
        '--check-public',
      ]);
      expect(f.output).toHaveBeenCalledWith(
        expect.objectContaining({
          include: [
            expect.objectContaining({ repo: 'Before/repo' }),
            expect.objectContaining({ repo: 'After/repo' }),
            expect.objectContaining({ repo: 'NormanMul/Pronoia' }),
          ],
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(String(status)),
      );
    } finally {
      warn.mockRestore();
    }
  },
);

it('does not admit non-sample paths through an attested own-sample bundle', async () => {
  const f = fixture();
  const sarif = JSON.parse(
    readFileSync(
      new URL('../../../samples/security/sarif.json', import.meta.url),
      'utf8',
    ),
  ) as {
    runs: {
      results: {
        locations: {
          physicalLocation: { artifactLocation: { uri: string } };
        }[];
      }[];
    }[];
  };
  for (const run of sarif.runs)
    for (const result of run.results)
      for (const location of result.locations)
        location.physicalLocation.artifactLocation.uri =
          'src/not-the-sample.ts';
  const file = sampleBundle({ sarif });
  try {
    await expect(
      f.program.parseAsync(['node', 'cli', 'ingest-sarif', file, '--bundle']),
    ).rejects.toThrow(/configured|sample/i);
    expect(f.repos).not.toHaveBeenCalled();
  } finally {
    rmSync(file, { force: true });
  }
});

it('retains the public-board private-target rejection for the mandatory sample', async () => {
  const f = fixture();
  f.board.integrations.targetApi = f.api;
  f.repos.mockResolvedValue({ data: { private: true } } as Awaited<
    ReturnType<typeof f.api.rest.repos.get>
  >);
  const file = sampleBundle();
  try {
    await expect(
      f.program.parseAsync(['node', 'cli', 'ingest-sarif', file, '--bundle']),
    ).rejects.toThrow(/private|public/i);
  } finally {
    rmSync(file, { force: true });
  }
});

it('does not plan an inaccessible mandatory sample ahead of otherwise eligible external targets', async () => {
  const f = fixture();
  f.board.integrations.targetApi = f.api;
  f.repos.mockImplementation(async (params) => {
    if (params?.owner === 'NormanMul')
      throw Object.assign(new Error('sample metadata unavailable'), {
        status: 404,
      });
    return { data: { private: false } } as Awaited<
      ReturnType<typeof f.api.rest.repos.get>
    >;
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await f.program.parseAsync([
      'node',
      'cli',
      'scan-targets',
      '--check-public',
    ]);
    expect(f.output).toHaveBeenCalledWith(
      expect.objectContaining({
        include: [expect.objectContaining({ repo: 'Fabrikam/external' })],
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('404'));
  } finally {
    warn.mockRestore();
  }
});

it('supports the requested READ-token alias without changing current-name precedence or writer/DISMISS credentials', () => {
  expect(targetReadCredential({ PRONOIA_SCAN_TOKEN: 'legacy-read' })).toBe(
    'legacy-read',
  );
  expect(
    targetReadCredential({
      PRONOIA_TARGET_TOKEN: 'current-read',
      PRONOIA_SCAN_TOKEN: 'legacy-read',
    }),
  ).toBe('current-read');
  expect(
    targetReadCredential({
      GITHUB_TOKEN: 'writer',
      PRONOIA_DISMISS_TOKEN: 'dismiss',
    }),
  ).toBeUndefined();
});
