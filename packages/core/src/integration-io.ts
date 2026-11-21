import type { TokenCredential } from '@azure/identity';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  exportFileSchema,
  exportHeaders,
  exportManifestSchema,
} from './export-contract.js';

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function integrationFailure(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return 'Invalid integration response or configuration.';
  const status = z
    .object({ status: z.number().int().min(400).max(599) })
    .safeParse(error);
  return status.success
    ? `HTTP ${status.data.status}; check integration permissions and configuration.`
    : 'Integration request failed or timed out; check configuration and retry.';
}

export async function boundedFetch(
  transport: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  attempts: 1 | 2 = 2,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const deadline = AbortSignal.timeout(10000);
      const response = await transport(input, {
        ...init,
        redirect: 'error',
        signal: init?.signal
          ? AbortSignal.any([deadline, init.signal])
          : deadline,
      });
      if (
        attempt + 1 < attempts &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
      } else return response;
    } catch {
      if (attempt + 1 === attempts)
        throw new IntegrationError('Integration request failed or timed out.');
    }
    await delay(250);
  }
  throw new IntegrationError('Integration retry limit reached.');
}

export type SharePointOptions = {
  env?: Record<string, string | undefined>;
  credential?: TokenCredential;
  fetch?: typeof fetch;
};
export type SharePointReport = {
  status: 'skipped' | 'uploaded' | 'degraded';
  uploaded: number;
  snapshots: number;
  warnings: string[];
};

const graphOrigin = 'https://graph.microsoft.com';
const graphScope = `${graphOrigin}/.default`;
const opaqueId = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[A-Za-z0-9!_,.-]+$/)
  .refine((id) => !id.includes('..'));
const folderSegment = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/)
  .refine((name) => !/[. ]$/.test(name));
const spConfigSchema = z.object({
  SP_SITE_ID: opaqueId,
  SP_DRIVE_ID: opaqueId,
  SP_FOLDER: z
    .string()
    .min(1)
    .max(1000)
    .refine((path) =>
      path.split('/').every((part) => folderSegment.safeParse(part).success),
    ),
});
const driveItemSchema = z.object({
  id: opaqueId,
  name: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  folder: z.object({}).optional(),
  file: z.object({}).optional(),
  remoteItem: z.object({}).optional(),
  deleted: z.object({}).optional(),
  parentReference: z.object({ driveId: opaqueId.optional() }).optional(),
});
const drivePageSchema = z.object({
  value: z.array(z.object({ id: opaqueId })).max(1000),
  '@odata.nextLink': z.url().optional(),
});
type Upload = { snapshot: string; file: string; bytes: Buffer };

async function localFile(
  root: string,
  parts: string[],
  maxBytes: number,
): Promise<Buffer> {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    )
      throw new IntegrationError(
        'Exports must contain only regular files and directories, not symbolic links.',
      );
    if (index === parts.length - 1 && stat.size > maxBytes)
      throw new IntegrationError(
        'Export exceeds the bounded SharePoint upload size.',
      );
  }
  return readFile(path);
}

async function verifiedUploads(directory: string): Promise<Upload[]> {
  const root = resolve(z.string().min(1).max(4096).parse(directory));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new IntegrationError(
      'Export directory must be a regular managed directory.',
    );
  const snapshots = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.name === 'latest' || z.iso.date().safeParse(entry.name).success,
    )
    .map((entry) => entry.name)
    .sort((a, b) =>
      a === 'latest' ? -1 : b === 'latest' ? 1 : a.localeCompare(b),
    );
  if (
    !snapshots.includes('latest') ||
    snapshots.length < 2 ||
    snapshots.length > 100
  )
    throw new IntegrationError(
      'Export directory must contain latest and at least one dated snapshot (maximum 100).',
    );
  const assets: Upload[] = [];
  const manifests: Upload[] = [];
  let total = 0;
  for (const snapshot of snapshots) {
    const manifestBytes = await localFile(
      root,
      [snapshot, 'manifest.json'],
      2 * 1024 * 1024,
    );
    const manifest = exportManifestSchema.parse(
      JSON.parse(manifestBytes.toString('utf8')),
    );
    if (
      !Object.keys(exportHeaders).every((file) =>
        Object.hasOwn(manifest.sha256, file),
      )
    )
      throw new IntegrationError(
        'Every export manifest must hash all six managed CSVs.',
      );
    for (const [file, hash] of Object.entries(manifest.sha256)) {
      exportFileSchema.parse(file);
      const bytes = await localFile(
        root,
        [snapshot, ...file.split('/')],
        250_000_000,
      );
      if (
        createHash('sha256').update(bytes).digest('hex') !== hash ||
        (file.endsWith('.png') && !file.endsWith(`-${hash.slice(0, 8)}.png`))
      )
        throw new IntegrationError(
          'Export hash verification failed; regenerate exports before uploading.',
        );
      total += bytes.length;
      if (total > 512 * 1024 * 1024 || assets.length >= 10000)
        throw new IntegrationError(
          'Export batch exceeds 512 MiB or 10,000 managed assets.',
        );
      assets.push({ snapshot, file, bytes });
    }
    manifests.push({ snapshot, file: 'manifest.json', bytes: manifestBytes });
  }
  // Hold verified bytes so a file changed during upload cannot bypass the preflight hash check.
  return [...assets, ...manifests];
}

export async function uploadSharePoint(
  directory: string,
  options: SharePointOptions = {},
): Promise<SharePointReport> {
  const report: SharePointReport = {
    status: 'skipped',
    uploaded: 0,
    snapshots: 0,
    warnings: [],
  };
  const env = options.env ?? process.env;
  const keys = ['SP_SITE_ID', 'SP_DRIVE_ID', 'SP_FOLDER'] as const;
  const missing = keys.filter((key) => !env[key]);
  if (missing.length === keys.length) {
    report.warnings.push(
      'SharePoint skipped: set SP_SITE_ID, SP_DRIVE_ID and SP_FOLDER to enable uploads.',
    );
    return report;
  }
  try {
    if (missing.length)
      throw new IntegrationError(
        `SharePoint configuration incomplete: set ${missing.join(', ')}.`,
      );
    const parsed = spConfigSchema.safeParse(env);
    if (!parsed.success)
      throw new IntegrationError(
        'Set valid SP_SITE_ID, SP_DRIVE_ID and a safe relative SP_FOLDER (no traversal or reserved characters).',
      );
    if (
      [
        'AZURE_CLIENT_SECRET',
        'AZURE_CLIENT_CERTIFICATE_PATH',
        'AZURE_CLIENT_CERTIFICATE_PASSWORD',
      ].some((key) => env[key] || (!options.credential && process.env[key]))
    )
      throw new IntegrationError(
        'SharePoint requires managed/workload identity or Azure CLI OIDC, never static Entra credentials.',
      );
    const files = await verifiedUploads(directory);
    const config = parsed.data;
    const credential =
      options.credential ??
      new (await import('@azure/identity')).DefaultAzureCredential({
        processTimeoutInMs: 10000,
      });
    const transport = options.fetch ?? fetch;
    let token: { token: string; expiresOnTimestamp: number } | null = null;
    async function graph<T>(
      path: string,
      schema: z.ZodType<T>,
      init?: RequestInit,
    ): Promise<T> {
      if (!token || token.expiresOnTimestamp < Date.now() + 60000) {
        token = z
          .object({
            token: z.string().min(1),
            expiresOnTimestamp: z.number().finite(),
          })
          .parse(
            await credential.getToken(graphScope, {
              abortSignal: AbortSignal.timeout(10000),
              requestOptions: { timeout: 10000 },
            }),
          );
      }
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token.token}`);
      const response = await boundedFetch(
        transport,
        path.startsWith('https:') ? path : `${graphOrigin}/v1.0${path}`,
        {
          ...init,
          headers,
        },
      );
      if (!response.ok)
        throw new IntegrationError(
          `SharePoint HTTP ${response.status}; check Sites.Selected grant, drive and folder configuration.`,
          response.status,
        );
      const json: unknown = await response.json();
      return schema.parse(json);
    }
    const drivesPath = `/sites/${encodeURIComponent(config.SP_SITE_ID)}/drives`;
    let next: string | undefined = `${graphOrigin}/v1.0${drivesPath}`;
    const seen = new Set<string>();
    let driveFound = false;
    while (next && !driveFound) {
      const link = new URL(next);
      if (
        link.origin !== graphOrigin ||
        link.username ||
        link.password ||
        link.pathname !== `/v1.0${drivesPath}` ||
        seen.has(next) ||
        seen.size >= 100
      )
        throw new IntegrationError(
          'SharePoint rejected an unsafe or unbounded site-drive pagination link.',
        );
      seen.add(next);
      const page: z.infer<typeof drivePageSchema> = await graph(
        next,
        drivePageSchema,
      );
      driveFound = page.value.some((drive) => drive.id === config.SP_DRIVE_ID);
      next = page['@odata.nextLink'];
    }
    if (!driveFound)
      throw new IntegrationError(
        'Configured SharePoint drive does not belong to the configured site.',
      );
    const drivePath = `/drives/${encodeURIComponent(config.SP_DRIVE_ID)}`;
    function checkedFolder(
      item: z.infer<typeof driveItemSchema>,
      name: string,
    ): string {
      if (
        !item.folder ||
        item.remoteItem ||
        item.deleted ||
        item.name !== name ||
        (item.parentReference?.driveId &&
          item.parentReference.driveId !== config.SP_DRIVE_ID)
      )
        throw new IntegrationError(
          'SharePoint folder is not the approved local folder in the configured drive.',
        );
      return item.id;
    }
    const baseName = config.SP_FOLDER.split('/').at(-1) ?? '';
    let base: z.infer<typeof driveItemSchema>;
    try {
      base = await graph(
        `${drivePath}/root:/${config.SP_FOLDER.split('/').map(encodeURIComponent).join('/')}`,
        driveItemSchema,
      );
    } catch (error) {
      if (error instanceof IntegrationError && error.status === 404)
        throw new IntegrationError(
          'SP_FOLDER must already exist; ask an administrator to create the approved export folder.',
        );
      throw error;
    }
    const folders = new Map([['', checkedFolder(base, baseName)]]);
    async function ensureFolder(parts: string[]): Promise<string> {
      let parent = folders.get('') ?? '';
      let relative = '';
      for (const name of parts) {
        relative = relative ? `${relative}/${name}` : name;
        const existing = folders.get(relative);
        if (existing) {
          parent = existing;
          continue;
        }
        const lookup = `${drivePath}/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`;
        let item: z.infer<typeof driveItemSchema>;
        try {
          item = await graph(lookup, driveItemSchema);
        } catch (error) {
          if (!(error instanceof IntegrationError) || error.status !== 404)
            throw error;
          try {
            item = await graph(
              `${drivePath}/items/${encodeURIComponent(parent)}/children`,
              driveItemSchema,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  name,
                  folder: {},
                  '@microsoft.graph.conflictBehavior': 'fail',
                }),
              },
            );
          } catch (conflict) {
            if (
              !(conflict instanceof IntegrationError) ||
              conflict.status !== 409
            )
              throw conflict;
            item = await graph(lookup, driveItemSchema);
          }
        }
        parent = checkedFolder(item, name);
        folders.set(relative, parent);
      }
      return parent;
    }
    for (const file of files) {
      const parts = [file.snapshot, ...file.file.split('/')];
      const name = parts.pop() ?? '';
      const parent = await ensureFolder(parts);
      const contentType = name.endsWith('.png')
        ? 'image/png'
        : name.endsWith('.csv')
          ? 'text/csv; charset=utf-8'
          : name.endsWith('.md')
            ? 'text/markdown; charset=utf-8'
            : 'application/json';
      const result = await graph(
        `${drivePath}/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/content`,
        driveItemSchema,
        {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body: new Uint8Array(file.bytes),
        },
      );
      if (
        !result.file ||
        result.remoteItem ||
        result.deleted ||
        result.name !== name ||
        result.size !== file.bytes.length ||
        (result.parentReference?.driveId &&
          result.parentReference.driveId !== config.SP_DRIVE_ID)
      )
        throw new IntegrationError(
          'SharePoint upload returned unexpected file metadata; verify the remote export before retrying.',
        );
      report.uploaded += 1;
      if (name === 'manifest.json') report.snapshots += 1;
    }
    report.status = 'uploaded';
  } catch (error) {
    report.status = 'degraded';
    report.warnings.push(`SharePoint: ${integrationFailure(error)}`);
  }
  return report;
}
