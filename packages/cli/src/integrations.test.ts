import { Command } from 'commander';
import { Octokit } from 'octokit';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  Board,
  configSchema,
  exportResultSchema,
  marker,
  parseCsv,
} from '@pronoia/core';
import { registerM4Commands } from './integrations.js';

function fixture() {
  const config = configSchema.parse({ board_repo: 'Contoso/demo' });
  const issue = {
    number: 1,
    title: 'Synthetic challenge',
    body: marker('meta', {
      dedupe_key: 'checklist/contoso/T1',
      assessment: 'Contoso synthetic',
      test_id: 'T1',
      source: 'checklist',
      synthetic: true,
    }),
    labels: ['pronoia', 'status:todo', 'severity:high'],
    assignees: [],
    state: 'open',
    created_at: '2026-11-01T12:00:00Z',
    updated_at: '2026-11-01T12:00:00Z',
    html_url: 'https://github.com/Contoso/demo/issues/1',
  };
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(init?.method ?? 'GET');
    const url = new URL(String(input));
    if (url.pathname.endsWith('/issues/1/comments')) return Response.json([]);
    if (url.pathname.endsWith('/issues/1')) return Response.json(issue);
    if (url.pathname.endsWith('/issues')) return Response.json([issue]);
    if (url.pathname.endsWith('/contents/sessions'))
      return Response.json({ message: 'Not Found' }, { status: 404 });
    throw new Error('Unexpected synthetic integration request.');
  };
  const board = new Board(
    new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    config,
  );
  const output: unknown[] = [];
  const factory = vi.fn(() => board);
  const program = new Command().exitOverride();
  registerM4Commands(program, {
    board: factory,
    config: () => config,
    output: (value) => output.push(value),
  });
  return { program, output, requests, factory };
}

it('lists and reads canonical findings without issue mutations', async () => {
  const f = fixture();
  await f.program.parseAsync([
    'node',
    'pronoia',
    'board-list',
    '--assessment',
    'Contoso synthetic',
    '--status',
    'todo',
    '--limit',
    '1',
  ]);
  expect(f.output[0]).toMatchObject({
    items: [{ issue: { number: 1 }, state: { status: 'todo' } }],
  });
  const detail = fixture();
  await detail.program.parseAsync([
    'node',
    'pronoia',
    'item-get',
    '--issue',
    '1',
  ]);
  expect(detail.output[0]).toMatchObject({
    issue: { number: 1 },
    comments: [],
    state: { status: 'todo' },
  });
  expect(
    [...f.requests, ...detail.requests].every((method) => method === 'GET'),
  ).toBe(true);
});

it('refuses invalid board limits before resolving a GitHub credential', async () => {
  const f = fixture();
  await expect(
    f.program.parseAsync(['node', 'pronoia', 'board-list', '--limit', '101']),
  ).rejects.toThrow();
  expect(f.factory).not.toHaveBeenCalled();
});

it('writes an exact-contract export through the real CLI handler with no GitHub writes', async () => {
  const f = fixture();
  const folder = await mkdtemp(path.join(tmpdir(), 'pronoia-cli-export-'));
  try {
    await f.program.parseAsync(['node', 'pronoia', 'export', '--out', folder]);
    const result = exportResultSchema.parse(f.output[0]);
    expect(result.manifest.row_counts['findings.csv']).toBe(1);
    const [header, row] = parseCsv(
      await readFile(path.join(folder, 'latest', 'findings.csv'), 'utf8'),
    );
    expect(header?.[0]).toBe('issue');
    expect(row?.[0]).toBe('1');
    expect(f.requests.every((method) => method === 'GET')).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
