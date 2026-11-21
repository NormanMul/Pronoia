import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configSchema } from './config.js';
import { marker, metaSchema } from './assessment.js';
import { evidencePath } from './evidence.js';
import { parseCsv, stringifyCsv } from './csv.js';
import { nextState, parseCommand } from './workflow/engine.js';
import { stateSchema, type Audit } from './workflow/schemas.js';
import { Board, type Issue, type IssueComment } from './github.js';
import {
  exportHeaders,
  type ExportCsv,
  type ExportSnapshot,
} from './export-contract.js';
import {
  buildExports,
  exportBoard,
  publishExports,
  writeExports,
} from './exporter.js';

const config = configSchema.parse({ board_repo: 'Contoso/demo' });
const generatedAt = '2026-11-05T12:00:00.000Z';
const session = '11111111-1111-4111-8111-111111111111';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
function fixture() {
  const issue: Issue = {
    number: 1,
    title: '=HYPERLINK("https://example.com","synthetic input")',
    body: marker(
      'meta',
      metaSchema.parse({
        dedupe_key: 'checklist/contoso/T1',
        assessment: 'Contoso synthetic',
        test_id: 'T1',
        category: 'Identity',
        source: 'checklist',
        test_description: 'Synthetic challenge check',
        procedure: 'Run the synthetic challenge',
        expected_result: 'Challenge appears',
        actual_result: 'Challenge appeared',
        remediation: ['Require the synthetic challenge'],
        synthetic: true,
      }),
    ),
    labels: ['pronoia', 'status:in-progress', 'severity:high'],
    assignees: [{ login: 'operator', type: 'User' }],
    state: 'open',
    created_at: '2026-11-01T12:00:00Z',
    updated_at: '2026-11-04T12:00:00Z',
    html_url: 'https://github.com/Contoso/demo/issues/1',
  };
  const comments: IssueComment[] = [];
  let state = stateSchema.parse({ evidence_count: 1 });
  for (const [index, body] of [
    '/start',
    '/validate Synthetic proof',
    '/approve',
  ].entries()) {
    const at = `2026-11-0${index + 2}T12:00:00.000Z`;
    const command = parseCommand(body);
    if (!command) throw new Error('Missing synthetic command.');
    const actor = index === 2 ? 'validator' : 'operator';
    const next = nextState(
      state,
      command,
      {
        login: actor,
        userType: 'User',
        association: 'COLLABORATOR',
      },
      config,
      at,
    );
    const audit: Audit = {
      from: state.status,
      to: next.status,
      command,
      actor,
      actor_type: 'human',
      on_behalf_of: '',
      reason: command.reason,
      evidence_count: state.evidence_count,
      at,
      comment_id: index + 1,
      state: next,
    };
    comments.push({
      id: 10 + index,
      body: marker('transition', audit),
      user: { login: 'github-actions[bot]', type: 'Bot' },
      author_association: 'NONE',
      created_at: at,
      html_url: `https://github.com/Contoso/demo/issues/1#issuecomment-${10 + index}`,
    });
    state = next;
  }
  comments.push({
    ...comments[0],
    id: 99,
    body: marker('transition', {
      ...JSON.parse(
        comments[0]?.body.match(/transition (.*?) -->/)?.[1] ?? '{}',
      ),
      state: stateSchema.parse({ status: 'blocked' }),
    }),
    user: { login: 'outsider', type: 'User' },
    author_association: 'NONE',
    created_at: '2026-11-05T00:00:00Z',
    html_url: 'https://github.com/Contoso/demo/issues/1#issuecomment-99',
  });
  const file = evidencePath(1, png, '2026-11-03T11:00:00.000Z');
  const sha256 = createHash('sha256').update(png).digest('hex');
  comments.push({
    id: 98,
    body: marker('evidence', {
      file,
      sha256,
      captured_at: '2026-11-03T11:00:00.000Z',
      captured_by: 'operator',
      source: 'Synthetic screen',
      session,
      step: 'Challenge',
      note: 'Synthetic reviewed evidence.',
    }),
    user: { login: 'operator', type: 'User' },
    author_association: 'COLLABORATOR',
    created_at: '2026-11-03T11:00:00Z',
    html_url: 'https://github.com/Contoso/demo/issues/1#issuecomment-98',
  });
  const recapFile = `sessions/2026-11-03-${session}.md`;
  const recap =
    marker('session', {
      session_id: session,
      title: 'Contoso synthetic',
      started_at: '2026-11-03T10:00:00.000Z',
      ended_at: '2026-11-03T11:30:00.000Z',
      assessment: 'Contoso synthetic',
      items_touched: [1],
      recap_file: recapFile,
    }) + '\n\nSynthetic recap; verbal observations are not authority.';
  const snapshot: ExportSnapshot = {
    items: [{ issue, comments }],
    sessions: [{ file: recapFile, text: recap }],
    local_proposals: [],
  };
  return { snapshot, assets: new Map([[file, png]]), file };
}

function records(bytes: Buffer, csv: ExportCsv) {
  const [header, ...rows] = parseCsv(bytes.toString('utf8'));
  expect(header).toEqual(exportHeaders[csv]);
  return rows.map((row) =>
    Object.fromEntries(
      exportHeaders[csv].map((column, index) => [column, row[index]]),
    ),
  );
}

it('replays trusted audit state into exact CSVs, protects formulas and verifies published evidence hashes', () => {
  const f = fixture();
  const result = buildExports(config, f.snapshot, f.assets, generatedAt);
  const findings = records(
    result.files.get('findings.csv') ?? Buffer.alloc(0),
    'findings.csv',
  );
  expect(findings[0]).toMatchObject({
    issue: '1',
    status: 'done',
    validated_by: 'validator',
    evidence_count: '1',
    test_description: 'Synthetic challenge check',
    actual_result: 'Challenge appeared',
    title: '\'=HYPERLINK("https://example.com","synthetic input")',
  });
  expect(result.manifest.row_counts['decisions.csv']).toBe(3);
  expect(result.manifest.row_counts['sessions.csv']).toBe(1);
  const history = records(
    result.files.get('status-history.csv') ?? Buffer.alloc(0),
    'status-history.csv',
  );
  expect(history).toContainEqual({
    date: '2026-11-03',
    assessment: 'Contoso synthetic',
    status: 'validate',
    count: '1',
  });
  expect(history).toContainEqual({
    date: '2026-11-05',
    assessment: 'Contoso synthetic',
    status: 'done',
    count: '1',
  });
  expect(result.manifest.sha256[f.file]).toBe(
    createHash('sha256').update(png).digest('hex'),
  );
  expect(result.manifest.sha256['findings.csv']).toBe(
    createHash('sha256')
      .update(result.files.get('findings.csv') ?? Buffer.alloc(0))
      .digest('hex'),
  );
});

it('exports a read-only board snapshot and preserves local discarded proposal rows across repeat exports', async () => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'pronoia-export-'));
  const local = stringifyCsv([
    exportHeaders['ai-proposals.csv'],
    [
      '2026-11-03T11:00:00.000Z',
      session,
      'Analyst',
      1,
      'Synthetic unaccepted proposal.',
      '/validate',
      0.75,
      'discarded',
      'operator',
      'Synthetic reviewer declined.',
    ],
  ]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? 'GET');
    const url = new URL(String(input));
    if (url.pathname.endsWith('/issues/1/comments'))
      return Response.json(f.snapshot.items[0]?.comments);
    if (url.pathname.endsWith('/issues'))
      return Response.json(f.snapshot.items.map((item) => item.issue));
    if (url.pathname.endsWith('/contents/sessions'))
      return Response.json(
        f.snapshot.sessions.map((entry) => ({
          type: 'file',
          path: entry.file,
        })),
      );
    const file = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
    const bytes =
      f.assets.get(file) ??
      Buffer.from(
        f.snapshot.sessions.find((entry) => entry.file === file)?.text ?? '',
      );
    if (!bytes.length) throw new Error('Unexpected synthetic export request.');
    return Response.json({
      sha: 'a'.repeat(40),
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
  };
  const board = new Board(
    new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    config,
  );
  try {
    await writeFile(path.join(directory, 'ai-proposals.csv'), local);
    const first = await exportBoard(board, directory, generatedAt);
    const repeated = await exportBoard(board, directory, generatedAt);
    expect(repeated.manifest).toEqual(first.manifest);
    expect(first.manifest.row_counts['ai-proposals.csv']).toBe(1);
    expect(
      await readFile(path.join(directory, 'ai-proposals.csv'), 'utf8'),
    ).toBe(local);
    const exported = records(
      await readFile(path.join(directory, 'latest', 'ai-proposals.csv')),
      'ai-proposals.csv',
    );
    expect(exported[0]).toMatchObject({
      outcome: 'discarded',
      reason: 'Synthetic reviewer declined.',
    });
    expect(await readFile(path.join(directory, '2026-11-05', f.file))).toEqual(
      png,
    );
    expect(methods.every((method) => method === 'GET')).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses to replace unrelated existing directories or write escaping bundle paths', async () => {
  const f = fixture();
  const bundle = buildExports(config, f.snapshot, f.assets, generatedAt);
  const directory = await mkdtemp(path.join(tmpdir(), 'pronoia-export-'));
  try {
    await mkdir(path.join(directory, 'latest'));
    await writeFile(
      path.join(directory, 'latest', 'keep.txt'),
      'Synthetic unrelated file.',
    );
    await expect(writeExports(directory, bundle)).rejects.toThrow(
      /owned|existing|manifest|unrelated/i,
    );
    expect(
      await readFile(path.join(directory, 'latest', 'keep.txt'), 'utf8'),
    ).toBe('Synthetic unrelated file.');
    const unsafe = {
      ...bundle,
      files: new Map(bundle.files).set(
        '../escape.txt',
        Buffer.from('synthetic'),
      ),
    };
    await expect(writeExports(directory, unsafe)).rejects.toThrow();
    await expect(
      readFile(path.join(directory, 'escape.txt')),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('produces the same bytes when input comments are reordered and ignores forged outsider audits', () => {
  const f = fixture();
  const original = buildExports(config, f.snapshot, f.assets, generatedAt);
  const reordered: ExportSnapshot = {
    ...f.snapshot,
    items: f.snapshot.items.map((item) => ({
      ...item,
      comments: [...item.comments].reverse(),
    })),
  };
  const repeated = buildExports(config, reordered, f.assets, generatedAt);
  expect([...repeated.files]).toEqual([...original.files]);
});

it('refuses missing or mismatched evidence rather than reporting an unverified export', () => {
  const f = fixture();
  expect(() =>
    buildExports(config, f.snapshot, new Map(), generatedAt),
  ).toThrow(/evidence|missing/i);
  const wrong = new Map([[f.file, Buffer.from(png)]]);
  const altered = wrong.get(f.file);
  if (!altered) throw new Error('Missing synthetic asset.');
  altered[45] = (altered[45] ?? 0) ^ 1;
  expect(() => buildExports(config, f.snapshot, wrong, generatedAt)).toThrow(
    /hash|PNG|evidence/i,
  );
});

it('publishes verified snapshots without force and preserves dated export history', async () => {
  const f = fixture();
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pronoia-export-publish-'),
  );
  const updates: unknown[] = [];
  let blob = 0;
  const oldFile = 'exports/latest/evidence/1/20261101T110000Z-aaaaaaaa.png';
  const oldDatedFile =
    'exports/2026-11-05/evidence/1/20261101T110000Z-aaaaaaaa.png';
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    url.pathname = decodeURIComponent(url.pathname);
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === 'GET' && url.pathname.endsWith('/git/ref/heads/exports'))
      return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (
      method === 'GET' &&
      url.pathname.endsWith('/git/commits/' + 'a'.repeat(40))
    )
      return Response.json({ tree: { sha: 'b'.repeat(40) } });
    if (
      method === 'GET' &&
      url.pathname.endsWith('/git/trees/' + 'b'.repeat(40))
    )
      return Response.json({
        truncated: false,
        tree: [
          { path: oldFile, type: 'blob', sha: 'c'.repeat(40) },
          { path: oldDatedFile, type: 'blob', sha: 'c'.repeat(40) },
          {
            path: 'exports/2026-11-01/findings.csv',
            type: 'blob',
            sha: 'c'.repeat(40),
          },
        ],
      });
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) {
      blob += 1;
      return Response.json({ sha: blob.toString(16).padStart(40, '0') });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) {
      updates.push(body);
      return Response.json({ sha: 'd'.repeat(40) });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) {
      updates.push(body);
      return Response.json({ sha: 'e'.repeat(40) });
    }
    if (
      method === 'PATCH' &&
      url.pathname.endsWith('/git/refs/heads/exports')
    ) {
      updates.push(body);
      return Response.json({
        ref: 'refs/heads/exports',
        object: { sha: 'e'.repeat(40) },
      });
    }
    throw new Error(
      `Unexpected synthetic export publication request: ${method} ${url.pathname}.`,
    );
  };
  const board = new Board(
    new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    config,
  );
  try {
    await writeExports(
      directory,
      buildExports(config, f.snapshot, f.assets, generatedAt),
    );
    const result = await publishExports(board, directory);
    expect(result).toEqual({
      url: 'https://github.com/Contoso/demo/tree/exports/exports/latest',
      sha: 'e'.repeat(40),
    });
    const tree = z
      .object({
        base_tree: z.string(),
        tree: z.array(
          z.object({
            path: z.string(),
            mode: z.string(),
            type: z.string(),
            sha: z.string().nullable(),
          }),
        ),
      })
      .parse(updates[0]);
    expect(tree.tree).toContainEqual({
      path: oldFile,
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(tree.tree).toContainEqual({
      path: oldDatedFile,
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(
      tree.tree.some((entry) => entry.path.startsWith('exports/2026-11-05/')),
    ).toBe(true);
    expect(
      tree.tree.some((entry) => entry.path.startsWith('exports/2026-11-01/')),
    ).toBe(false);
    expect(updates[1]).toMatchObject({ parents: ['a'.repeat(40)] });
    expect(updates[2]).toMatchObject({ force: false, sha: 'e'.repeat(40) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses a tampered local export before making any GitHub publication request', async () => {
  const f = fixture();
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pronoia-export-publish-'),
  );
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error('No remote request expected.');
  });
  const board = new Board(
    new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
    config,
  );
  try {
    await writeExports(
      directory,
      buildExports(config, f.snapshot, f.assets, generatedAt),
    );
    await writeFile(
      path.join(directory, 'latest', 'findings.csv'),
      'Synthetic tampered contents.',
    );
    await expect(publishExports(board, directory)).rejects.toThrow(
      /hash|manifest|changed/i,
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects an incomplete bundle without creating a success-shaped snapshot lacking its manifest', async () => {
  const f = fixture();
  const complete = buildExports(config, f.snapshot, f.assets, generatedAt);
  const files = new Map(complete.files);
  files.delete('manifest.json');
  const directory = await mkdtemp(path.join(tmpdir(), 'pronoia-export-'));
  try {
    await expect(
      writeExports(directory, { ...complete, files }),
    ).rejects.toThrow(/manifest/i);
    await expect(
      readFile(path.join(directory, 'latest', 'findings.csv')),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('deduplicates a published outcome against its already formula-guarded local CSV representation', () => {
  const f = fixture();
  const record = {
    at: '2026-11-03T11:00:00.000Z',
    session,
    agent: 'Analyst',
    issue: 1,
    proposal: 'Synthetic accepted proposal.',
    proposed_command: '/validate' as const,
    confidence: 0.75,
    outcome: 'accepted' as const,
    reviewer: 'operator',
    reason: '-Synthetic human review.',
  };
  const item = f.snapshot.items[0];
  if (!item) throw new Error('Missing synthetic item.');
  item.comments.push({
    id: 100,
    body: marker('ai-proposal', record),
    user: { login: 'operator', type: 'User' },
    author_association: 'COLLABORATOR',
    created_at: record.at,
    html_url: 'https://github.com/Contoso/demo/issues/1#issuecomment-100',
  });
  f.snapshot.local_proposals.push({
    ...record,
    reason: "'-Synthetic human review.",
  });
  const result = buildExports(config, f.snapshot, f.assets, generatedAt);
  expect(result.manifest.row_counts['ai-proposals.csv']).toBe(1);
  expect(
    records(
      result.files.get('ai-proposals.csv') ?? Buffer.alloc(0),
      'ai-proposals.csv',
    ),
  ).toHaveLength(1);
});
