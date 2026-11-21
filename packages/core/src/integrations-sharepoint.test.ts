import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { exportHeaders, exportManifestSchema } from './export-contract.js';
import { uploadSharePoint } from './integrations.js';

const directories: string[] = [];
const config = {
  SP_SITE_ID: 'synthetic-site',
  SP_DRIVE_ID: 'synthetic-drive',
  SP_FOLDER: 'Approved Reports/Pronoia',
};

async function exportsFixture() {
  const directory = resolve(`.synthetic-sharepoint-${randomUUID()}`);
  directories.push(directory);
  const asset = Buffer.from('Synthetic asset, never real meeting data.');
  const assetHash = createHash('sha256').update(asset).digest('hex');
  const files = new Map(
    Object.entries(exportHeaders).map(([file, headers]) => [
      file,
      Buffer.from(`${headers.join(',')}\n`),
    ]),
  );
  files.set(`evidence/42/20261120T120000Z-${assetHash.slice(0, 8)}.png`, asset);
  files.set(
    'sessions/2026-11-20-synthetic.md',
    Buffer.from('# Synthetic recap\n'),
  );
  for (const snapshot of ['latest', '2026-11-20']) {
    for (const [file, bytes] of files) {
      const path = join(directory, snapshot, ...file.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const manifest = exportManifestSchema.parse({
      schema_version: 1,
      generated_at: '2026-11-20T12:00:00Z',
      period: { start: '2026-11-20T00:00:00Z', end: '2026-11-20T12:00:00Z' },
      row_counts: Object.fromEntries(
        Object.keys(exportHeaders).map((file) => [file, 0]),
      ),
      sha256: Object.fromEntries(
        [...files].map(([file, bytes]) => [
          file,
          createHash('sha256').update(bytes).digest('hex'),
        ]),
      ),
    });
    await writeFile(
      join(directory, snapshot, 'manifest.json'),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(directory, snapshot, 'private-recording.wav'),
      'Synthetic ignored recording',
    );
  }
  return directory;
}

function graphFixture() {
  const requests: { url: string; method: string }[] = [];
  const uploads: { name: string; bytes: Buffer; parent: string }[] = [];
  const folders = new Map<string, string>();
  const created: { parent: string; name: string }[] = [];
  let driveAllowed = true;
  let baseMissing = false;
  let baseDrive = 'synthetic-drive';
  let nextLink =
    'https://graph.microsoft.com/v1.0/sites/synthetic-site/drives?$skiptoken=next';
  let failUploadAt = -1;
  const credential = {
    getToken: vi.fn(async () => ({
      token: 'synthetic-secret-token',
      expiresOnTimestamp: Date.now() + 3_600_000,
    })),
  };
  const folder = (id: string, name: string) => ({
    id,
    name,
    folder: {},
    parentReference: { driveId: baseDrive },
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? 'GET';
    requests.push({ url: url.href, method });
    expect(url.origin).toBe('https://graph.microsoft.com');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer synthetic-secret-token',
    );
    const path = decodeURIComponent(url.pathname);
    if (method === 'GET' && path.endsWith('/sites/synthetic-site/drives'))
      return Response.json(
        url.searchParams.has('$skiptoken')
          ? { value: driveAllowed ? [{ id: 'synthetic-drive' }] : [] }
          : { value: [{ id: 'other-drive' }], '@odata.nextLink': nextLink },
      );
    if (method === 'GET' && path.endsWith('/root:/Approved Reports/Pronoia'))
      return baseMissing
        ? Response.json({ error: { code: 'itemNotFound' } }, { status: 404 })
        : Response.json(folder('base-id', 'Pronoia'));
    const child = /\/items\/([^/:]+):\/([^/]+)$/.exec(path);
    if (method === 'GET' && child) {
      const id = folders.get(`${child[1]}:${child[2]}`);
      return id
        ? Response.json(folder(id, String(child[2])))
        : Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
    }
    const parent = /\/items\/([^/:]+)\/children$/.exec(path)?.[1];
    if (method === 'POST' && parent) {
      const { name } = z
        .object({
          name: z.string(),
          folder: z.object({}),
          '@microsoft.graph.conflictBehavior': z.literal('fail'),
        })
        .parse(JSON.parse(String(init?.body)));
      const id = `folder-${created.length}`;
      folders.set(`${parent}:${name}`, id);
      created.push({ parent, name });
      return Response.json(folder(id, name), { status: 201 });
    }
    const upload = /\/items\/([^/:]+):\/([^/]+):\/content$/.exec(path);
    if (method === 'PUT' && upload && init?.body instanceof Uint8Array) {
      const bytes = Buffer.from(init.body);
      uploads.push({
        name: String(upload[2]),
        bytes,
        parent: String(upload[1]),
      });
      if (uploads.length === failUploadAt)
        return Response.json(
          {
            error: { code: 'accessDenied', message: 'synthetic-secret-token' },
          },
          { status: 403 },
        );
      return Response.json(
        {
          id: `file-${uploads.length}`,
          name: upload[2],
          size: bytes.length,
          file: {},
          parentReference: { driveId: 'synthetic-drive' },
        },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected synthetic Graph request ${method} ${path}`);
  };
  return {
    fetcher,
    credential,
    requests,
    uploads,
    created,
    disallowDrive: () => {
      driveAllowed = false;
    },
    removeBase: () => {
      baseMissing = true;
    },
    setBaseDrive: (drive: string) => {
      baseDrive = drive;
    },
    setNextLink: (value: string) => {
      nextLink = value;
    },
    failUpload: (at: number) => {
      failUploadAt = at;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('manifest-verified SharePoint export', () => {
  it('uploads allowed assets in latest and dated snapshots, with both manifests last', async () => {
    const directory = await exportsFixture();
    const graph = graphFixture();
    const report = await uploadSharePoint(directory, {
      env: config,
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report).toEqual({
      status: 'uploaded',
      uploaded: 18,
      snapshots: 2,
      warnings: [],
    });
    expect(graph.uploads.slice(-2).map((upload) => upload.name)).toEqual([
      'manifest.json',
      'manifest.json',
    ]);
    expect(graph.uploads.map((upload) => upload.name)).not.toContain(
      'private-recording.wav',
    );
    expect(graph.created.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'latest',
        '2026-11-20',
        'evidence',
        '42',
        'sessions',
      ]),
    );
    expect(
      graph.created.some(
        (item) => item.name === 'Approved Reports' || item.name === 'Pronoia',
      ),
    ).toBe(false);
    expect(graph.credential.getToken).toHaveBeenCalledWith(
      'https://graph.microsoft.com/.default',
      expect.any(Object),
    );
  });

  it('checks every dated hash before authentication, folder creation or any upload', async () => {
    const directory = await exportsFixture();
    await writeFile(
      join(directory, '2026-11-20', 'findings.csv'),
      'Synthetic tampering',
    );
    const graph = graphFixture();
    const report = await uploadSharePoint(directory, {
      env: config,
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report).toMatchObject({
      status: 'degraded',
      uploaded: 0,
      snapshots: 0,
    });
    expect(report.warnings.join(' ')).toMatch(/hash/i);
    expect(graph.requests).toEqual([]);
    expect(graph.credential.getToken).not.toHaveBeenCalled();
  });

  it('rejects manifest traversal and missing managed CSVs without network writes', async () => {
    const directory = await exportsFixture();
    const path = join(directory, 'latest', 'manifest.json');
    const original = exportManifestSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    await writeFile(
      path,
      JSON.stringify({
        ...original,
        sha256: { '../private.txt': 'a'.repeat(64) },
      }),
    );
    const graph = graphFixture();
    expect(
      (
        await uploadSharePoint(directory, {
          env: config,
          credential: graph.credential,
          fetch: graph.fetcher,
        })
      ).status,
    ).toBe('degraded');
    await writeFile(path, JSON.stringify({ ...original, sha256: {} }));
    expect(
      (
        await uploadSharePoint(directory, {
          env: config,
          credential: graph.credential,
          fetch: graph.fetcher,
        })
      ).status,
    ).toBe('degraded');
    expect(graph.requests).toEqual([]);
  });

  it('skips absent configuration and diagnoses partial configuration before filesystem access', async () => {
    expect(await uploadSharePoint('unused', { env: {} })).toEqual({
      status: 'skipped',
      uploaded: 0,
      snapshots: 0,
      warnings: [
        'SharePoint skipped: set SP_SITE_ID, SP_DRIVE_ID and SP_FOLDER to enable uploads.',
      ],
    });
    const report = await uploadSharePoint('unused', {
      env: { SP_SITE_ID: 'synthetic-site' },
    });
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toMatch(/SP_DRIVE_ID.*SP_FOLDER/);
  });

  it.each([
    '../outside',
    'safe\\outside',
    'safe/%2Foutside',
    '/absolute',
    'folder.',
    'folder/#bad',
  ])('rejects unsafe approved folder %s', async (SP_FOLDER) => {
    const graph = graphFixture();
    const report = await uploadSharePoint('unused', {
      env: { ...config, SP_FOLDER },
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report.status).toBe('degraded');
    expect(graph.requests).toEqual([]);
  });

  it('refuses a foreign drive even after paginating the configured site', async () => {
    const directory = await exportsFixture();
    const graph = graphFixture();
    graph.disallowDrive();
    const report = await uploadSharePoint(directory, {
      env: config,
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toMatch(/drive.*site/i);
    expect(graph.requests).toHaveLength(2);
    expect(graph.created).toEqual([]);
    expect(graph.uploads).toEqual([]);
  });

  it('requires the administrator-created base folder and rejects a foreign folder drive', async () => {
    const directory = await exportsFixture();
    const graph = graphFixture();
    graph.removeBase();
    expect(
      (
        await uploadSharePoint(directory, {
          env: config,
          credential: graph.credential,
          fetch: graph.fetcher,
        })
      ).status,
    ).toBe('degraded');
    expect(graph.created).toEqual([]);
    const foreign = graphFixture();
    foreign.setBaseDrive('other-drive');
    expect(
      (
        await uploadSharePoint(directory, {
          env: config,
          credential: foreign.credential,
          fetch: foreign.fetcher,
        })
      ).status,
    ).toBe('degraded');
    expect(foreign.uploads).toEqual([]);
  });

  it('never forwards a Graph token to a hostile pagination link', async () => {
    const directory = await exportsFixture();
    const graph = graphFixture();
    graph.setNextLink('https://example.invalid/steal');
    const report = await uploadSharePoint(directory, {
      env: config,
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report.status).toBe('degraded');
    expect(graph.requests).toHaveLength(1);
  });

  it('reports partial HTTP failures without committing manifests or logging credentials', async () => {
    const directory = await exportsFixture();
    const graph = graphFixture();
    graph.failUpload(2);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = await uploadSharePoint(directory, {
      env: config,
      credential: graph.credential,
      fetch: graph.fetcher,
    });
    expect(report).toMatchObject({
      status: 'degraded',
      uploaded: 1,
      snapshots: 0,
    });
    expect(report.warnings.join(' ')).toContain('403');
    expect(JSON.stringify(report)).not.toContain('synthetic-secret-token');
    expect(graph.uploads.map((upload) => upload.name)).not.toContain(
      'manifest.json',
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses static deployed credentials rather than falling back to them', async () => {
    const report = await uploadSharePoint('unused', {
      env: {
        ...config,
        GITHUB_ACTIONS: 'true',
        AZURE_CLIENT_SECRET: 'synthetic-secret-token',
      },
    });
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toMatch(/identity|OIDC/i);
    expect(JSON.stringify(report)).not.toContain('synthetic-secret-token');
  });

  it('does not hide static process credentials behind injected SharePoint configuration', async () => {
    vi.stubEnv('AZURE_CLIENT_SECRET', 'synthetic-secret-token');
    const report = await uploadSharePoint('unused', { env: config });
    expect(report.status).toBe('degraded');
    expect(report.warnings.join(' ')).toMatch(/identity|OIDC/i);
    expect(JSON.stringify(report)).not.toContain('synthetic-secret-token');
  });
});
