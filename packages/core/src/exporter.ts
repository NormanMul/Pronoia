import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { configSchema, type Config } from './config.js';
import { issueSection, readMeta } from './assessment.js';
import { parseCsv, stringifyCsv } from './csv.js';
import { evidencePath, evidenceSchema } from './evidence.js';
import { isAuditWriter, readAudit } from './workflow/engine.js';
import { expectedState } from './workflow/guards.js';
import { statusSchema, type Audit } from './workflow/schemas.js';
import type { Board, IssueComment } from './github.js';
import {
  exportHeaders,
  exportCsvSchema,
  exportFileSchema,
  exportManifestSchema,
  exportSnapshotSchema,
  proposalOutcomeSchema,
  sessionRecordSchema,
  sessionFileSchema,
  type ExportCsv,
  type ExportManifest,
  type ExportSnapshot,
  type ProposalExport,
  type ExportResult,
} from './export-contract.js';

export class ExportError extends Error {}
export type ExportBundle = {
  files: Map<string, Buffer>;
  manifest: ExportManifest;
};

type Row = (string | number | boolean | null)[];
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function utc(value: string): string {
  z.iso.datetime({ offset: true }).parse(value);
  return new Date(value).toISOString();
}
function trustedData(comment: IssueComment): boolean {
  return (
    comment.user !== null &&
    (isAuditWriter(comment.user.login) ||
      ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association))
  );
}
function metadata<T>(body: string, name: string, schema: z.ZodType<T>): T[] {
  z.string()
    .regex(/^[a-z-]+$/)
    .parse(name);
  return [
    ...body.matchAll(new RegExp(`<!-- pronoia:${name} (.*?) -->`, 'gs')),
  ].map((match) => schema.parse(JSON.parse(match[1] ?? '')));
}
function proposalRow(proposal: ProposalExport): Row {
  return [
    proposal.at,
    proposal.session,
    proposal.agent,
    proposal.issue,
    proposal.proposal,
    proposal.proposed_command,
    proposal.confidence,
    proposal.outcome,
    proposal.reviewer,
    proposal.reason,
  ];
}

export function buildExports(
  rawConfig: Config,
  rawSnapshot: ExportSnapshot,
  assets: ReadonlyMap<string, Buffer>,
  generatedAt: string,
): ExportBundle {
  const config = configSchema.parse(rawConfig);
  const snapshot = exportSnapshotSchema.parse(rawSnapshot);
  const generated = utc(generatedAt);
  const files = new Map<string, Buffer>();
  const rows: Record<ExportCsv, Row[]> = {
    'findings.csv': [],
    'decisions.csv': [],
    'evidence.csv': [],
    'sessions.csv': [],
    'ai-proposals.csv': [],
    'status-history.csv': [],
  };
  const proposals = [...snapshot.local_proposals];
  const seenIssues = new Set<number>();
  const prepared = [...snapshot.items]
    .filter(
      ({ issue }) => issue.labels.includes('pronoia') && !issue.pull_request,
    )
    .sort((a, b) => a.issue.number - b.issue.number)
    .map(({ issue, comments: rawComments }) => {
      if (seenIssues.has(issue.number))
        throw new ExportError(`Duplicate issue ${issue.number} in export.`);
      seenIssues.add(issue.number);
      z.string().max(200000).parse(issue.body);
      const comments = [...rawComments].sort((a, b) => a.id - b.id);
      const state = expectedState(issue, comments, config);
      const meta = readMeta(issue.body);
      const assessment = meta?.assessment ?? 'Manual';
      const auditsByCommand = new Map<number, Audit>();
      const evidence = new Map<string, z.infer<typeof evidenceSchema>>();
      for (const comment of comments) {
        if (!comment.user) continue;
        const audit = readAudit(comment.body, comment.user.login);
        if (audit) auditsByCommand.set(audit.comment_id, audit);
        if (!trustedData(comment)) continue;
        for (const record of metadata(
          comment.body,
          'evidence',
          evidenceSchema,
        )) {
          if (!record.file.startsWith(`evidence/${issue.number}/`))
            throw new ExportError(
              `Cross-item evidence in comment ${comment.id}.`,
            );
          const bytes = assets.get(record.file);
          if (!bytes) throw new ExportError(`Missing evidence ${record.file}.`);
          if (
            hash(bytes) !== record.sha256 ||
            evidencePath(issue.number, bytes, record.captured_at) !==
              record.file
          )
            throw new ExportError(
              `Evidence hash/path mismatch: ${record.file}.`,
            );
          const previous = evidence.get(record.file);
          if (previous && previous.sha256 !== record.sha256)
            throw new ExportError(`Conflicting evidence: ${record.file}.`);
          evidence.set(record.file, record);
          files.set(record.file, bytes);
        }
        for (const proposal of metadata(
          comment.body,
          'ai-proposal',
          proposalOutcomeSchema,
        )) {
          if (
            proposal.issue !== issue.number ||
            (!isAuditWriter(comment.user.login) &&
              proposal.reviewer.toLowerCase() !==
                comment.user.login.toLowerCase())
          )
            throw new ExportError(
              `Invalid proposal actor or scope in comment ${comment.id}.`,
            );
          proposals.push(proposal);
        }
      }
      const audits = [...auditsByCommand.values()].sort(
        (a, b) => a.at.localeCompare(b.at) || a.comment_id - b.comment_id,
      );
      for (const audit of audits)
        rows['decisions.csv'].push([
          issue.number,
          utc(audit.at),
          audit.actor,
          audit.actor_type,
          audit.on_behalf_of,
          `/${audit.command.name}`,
          audit.from,
          audit.to,
          audit.failure_reason ?? audit.reason,
          audit.evidence_count,
        ]);
      const images = [...evidence.values()].sort((a, b) =>
        a.file.localeCompare(b.file),
      );
      const evidenceUrls = images.map(
        (image) =>
          `https://github.com/${config.board_repo}/blob/evidence/${image.file}?raw=true`,
      );
      images.forEach((image, index) =>
        rows['evidence.csv'].push([
          issue.number,
          image.file,
          evidenceUrls[index] ?? '',
          image.sha256,
          utc(image.captured_at),
          image.captured_by,
          image.source,
          image.session,
          image.step,
          image.note,
        ]),
      );
      const linkedPrs = new Set<string>();
      for (const text of [
        issue.body,
        ...comments.map((comment) => comment.body),
      ])
        for (const match of text.matchAll(
          /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*/g,
        ))
          linkedPrs.add(match[0]);
      rows['findings.csv'].push([
        issue.number,
        issue.html_url,
        assessment,
        issue.milestone?.title ?? meta?.milestone ?? '',
        meta?.test_id ?? '',
        issue.title,
        meta?.category ?? '',
        meta?.source ?? 'manual',
        state.severity,
        meta?.priority ?? 'p4',
        meta?.cve_ids.join(';') ?? '',
        meta?.cvss ?? null,
        meta?.epss ?? null,
        meta?.kev ?? false,
        state.status,
        state.resolution,
        state.assignees.join(';'),
        utc(issue.created_at),
        utc(issue.updated_at),
        state.due_date,
        state.status !== 'done' &&
          state.due_date !== null &&
          state.due_date < generated.slice(0, 10),
        state.confirmed_by,
        state.validation_requested_by,
        state.validated_by,
        state.validated_by_name,
        state.validated_at,
        state.disputed_by,
        state.dispute_type,
        state.dispute_reason,
        state.risk_until,
        state.reject_count,
        state.last_reject_reason,
        state.last_reject_by,
        state.blocked_reason,
        meta?.test_description || issueSection(issue.body, 'Test'),
        meta?.procedure || issueSection(issue.body, 'Procedure'),
        meta?.expected_result || issueSection(issue.body, 'Expected result'),
        meta?.actual_result || issueSection(issue.body, 'Actual result'),
        meta?.remediation.length
          ? meta.remediation.join('\n')
          : issueSection(issue.body, 'Remediation'),
        images.length,
        images.map((image) => image.file).join(';'),
        evidenceUrls.join(';'),
        [...linkedPrs].sort().join(';'),
      ]);
      return { issue, assessment, audits };
    });
  rows['decisions.csv'].sort(
    (a, b) =>
      String(a[1]).localeCompare(String(b[1])) || Number(a[0]) - Number(b[0]),
  );
  const seenSessions = new Set<string>();
  for (const published of [...snapshot.sessions].sort((a, b) =>
    a.file.localeCompare(b.file),
  )) {
    const records = metadata(published.text, 'session', sessionRecordSchema);
    if (records.length !== 1)
      throw new ExportError(
        `A published recap needs one session record: ${published.file}.`,
      );
    const record = records[0];
    if (
      !record ||
      record.recap_file !== published.file ||
      seenSessions.has(record.session_id)
    )
      throw new ExportError(
        `Duplicate or mismatched session: ${published.file}.`,
      );
    seenSessions.add(record.session_id);
    files.set(published.file, Buffer.from(published.text));
    rows['sessions.csv'].push([
      record.session_id,
      record.title,
      record.started_at,
      record.ended_at,
      record.assessment,
      [...record.items_touched].sort((a, b) => a - b).join(';'),
      record.recap_file,
    ]);
  }
  const uniqueProposals = new Map<string, Row>();
  for (const proposal of proposals) {
    const row = proposalRow(proposal);
    uniqueProposals.set(stringifyCsv([row]), row);
  }
  rows['ai-proposals.csv'] = [...uniqueProposals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
  if (prepared.length) {
    const first = prepared.reduce(
      (earliest, item) =>
        Math.min(earliest, Date.parse(utc(item.issue.created_at))),
      Infinity,
    );
    const assessments = [
      ...new Set(prepared.map((item) => item.assessment)),
    ].sort();
    const start = Date.parse(
      new Date(first).toISOString().slice(0, 10) + 'T00:00:00Z',
    );
    const end = Date.parse(generated.slice(0, 10) + 'T00:00:00Z');
    for (let day = start; day <= end; day += 86400000) {
      const counts = new Map<string, number>();
      for (const item of prepared) {
        if (Date.parse(item.issue.created_at) >= day + 86400000) continue;
        let status: z.infer<typeof statusSchema> = 'todo';
        for (const audit of item.audits)
          if (Date.parse(audit.at) < day + 86400000)
            status = audit.state.status;
        const key = `${item.assessment}\0${status}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const assessment of assessments)
        for (const status of statusSchema.options)
          rows['status-history.csv'].push([
            new Date(day).toISOString().slice(0, 10),
            assessment,
            status,
            counts.get(`${assessment}\0${status}`) ?? 0,
          ]);
    }
  }
  for (const csv of exportCsvSchema.options) {
    if (rows[csv].some((row) => row.length !== exportHeaders[csv].length))
      throw new ExportError(`Invalid row width in ${csv}.`);
    files.set(
      csv,
      Buffer.from(stringifyCsv([exportHeaders[csv], ...rows[csv]])),
    );
  }
  const manifest = exportManifestSchema.parse({
    schema_version: 1,
    generated_at: generated,
    period: {
      start: new Date(Date.parse(generated) - 7 * 86400000).toISOString(),
      end: generated,
    },
    row_counts: Object.fromEntries(
      exportCsvSchema.options.map((csv) => [csv, rows[csv].length]),
    ),
    sha256: Object.fromEntries(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, bytes]) => [file, hash(bytes)]),
    ),
  });
  files.set(
    'manifest.json',
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  );
  return { files, manifest };
}

export async function writeExports(
  directory: string,
  bundle: ExportBundle,
): Promise<ExportResult> {
  const manifest = exportManifestSchema.parse(bundle.manifest);
  if (!bundle.files.has('manifest.json'))
    throw new ExportError('The export bundle is missing its manifest.');
  for (const [file, bytes] of bundle.files) {
    if (file === 'manifest.json') continue;
    exportFileSchema.parse(file);
    if (hash(bytes) !== manifest.sha256[file])
      throw new ExportError(
        `Export file does not match its manifest: ${file}.`,
      );
  }
  for (const file of Object.keys(manifest.sha256))
    if (!bundle.files.has(file))
      throw new ExportError(`Missing export file: ${file}.`);
  for (const csv of exportCsvSchema.options)
    if (!bundle.files.has(csv))
      throw new ExportError(`Missing export CSV: ${csv}.`);
  const output = path.resolve(z.string().min(1).parse(directory));
  const destinations = [
    path.join(output, manifest.generated_at.slice(0, 10)),
    path.join(output, 'latest'),
  ];
  for (const destination of destinations) await ownedSnapshot(destination);
  await mkdir(output, { recursive: true });
  for (const destination of destinations) {
    const staging = await mkdtemp(path.join(output, '.pronoia-export-'));
    const backup = path.join(output, `.pronoia-previous-${randomUUID()}`);
    let previousMoved = false;
    try {
      for (const [file, bytes] of bundle.files) {
        const target = path.join(staging, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          file === 'manifest.json'
            ? JSON.stringify(manifest, null, 2) + '\n'
            : bytes,
          { mode: 0o600 },
        );
      }
      if (await ownedSnapshot(destination)) {
        await rename(destination, backup);
        previousMoved = true;
      }
      try {
        await rename(staging, destination);
      } catch (error) {
        if (previousMoved) {
          try {
            await rename(backup, destination);
            previousMoved = false;
          } catch (restore) {
            throw new AggregateError(
              [error, restore],
              'Export replacement and rollback failed; the previous snapshot remains in its named backup.',
            );
          }
        }
        throw error;
      }
      if (previousMoved) {
        await rm(backup, { recursive: true });
        previousMoved = false;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return { directory: output, manifest };
}

async function ownedSnapshot(destination: string): Promise<boolean> {
  if (
    !/^(?:latest|\d{4}-\d{2}-\d{2})$/.test(path.basename(destination)) ||
    [path.parse(destination).root, homedir(), process.cwd()].includes(
      destination,
    ) ||
    existsSync(path.join(destination, '.git'))
  )
    throw new ExportError(
      'Export snapshots cannot replace a protected root directory.',
    );
  let entry;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (errorCode(error, 'ENOENT')) return false;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new ExportError(
      'The existing export destination is not an owned directory.',
    );
  let old: ExportManifest;
  try {
    old = exportManifestSchema.parse(
      JSON.parse(
        await readFile(path.join(destination, 'manifest.json'), 'utf8'),
      ),
    );
  } catch (error) {
    if (
      errorCode(error, 'ENOENT') ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      throw new ExportError(
        'The existing directory has no valid Pronoia manifest; unrelated files were preserved.',
      );
    throw error;
  }
  for (const relative of await readdir(destination, { recursive: true })) {
    const file = relative.split(path.sep).join('/');
    const info = await lstat(path.join(destination, relative));
    if (info.isSymbolicLink())
      throw new ExportError('Export snapshots cannot contain links.');
    if (info.isDirectory()) {
      if (
        file !== 'sessions' &&
        file !== 'evidence' &&
        !/^evidence\/[1-9]\d*$/.test(file)
      )
        throw new ExportError(
          'An existing snapshot contains an unrelated directory.',
        );
    } else if (file !== 'manifest.json') {
      if (
        !old.sha256[file] ||
        hash(await readFile(path.join(destination, relative))) !==
          old.sha256[file]
      )
        throw new ExportError(
          `An existing export file was changed or is unrelated: ${file}.`,
        );
    }
  }
  return true;
}

function errorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function proposalCsv(text: string): ProposalExport[] {
  const [header, ...rows] = parseCsv(text);
  if (
    !header ||
    header.join('\0') !== exportHeaders['ai-proposals.csv'].join('\0')
  )
    throw new ExportError('Local proposal CSV has an incompatible header.');
  return rows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => {
      if (row.length !== header.length)
        throw new ExportError('Local proposal CSV has an invalid row width.');
      const issue = z.string().parse(row[3]);
      const confidence = z.string().min(1).parse(row[6]);
      return proposalOutcomeSchema.parse({
        ...Object.fromEntries(header.map((name, index) => [name, row[index]])),
        issue: issue === '' ? null : Number(issue),
        confidence: Number(confidence),
      });
    });
}

export async function exportBoard(
  board: Board,
  directory: string,
  generatedAt?: string,
): Promise<ExportResult> {
  const snapshot: ExportSnapshot = {
    items: [],
    sessions: [],
    local_proposals: [],
  };
  const assets = new Map<string, Buffer>();
  for (const issue of await board.issues()) {
    const comments = await board.comments(issue.number);
    snapshot.items.push({ issue, comments });
    for (const comment of comments.filter(trustedData))
      for (const evidence of metadata(
        comment.body,
        'evidence',
        evidenceSchema,
      )) {
        if (!evidence.file.startsWith(`evidence/${issue.number}/`))
          throw new ExportError(
            `Cross-item evidence in comment ${comment.id}.`,
          );
        if (!assets.has(evidence.file))
          assets.set(evidence.file, await board.readEvidence(evidence.file));
      }
  }
  let sessions: { type: string; path: string }[];
  try {
    sessions = z.array(z.object({ type: z.string(), path: z.string() })).parse(
      (
        await board.api.rest.repos.getContent({
          ...board.scope,
          path: 'sessions',
          ref: 'main',
        })
      ).data,
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    )
      sessions = [];
    else throw error;
  }
  for (const entry of sessions) {
    if (
      entry.type !== 'file' ||
      !sessionFileSchema.safeParse(entry.path).success
    )
      continue;
    const file = z
      .object({
        encoding: z.literal('base64'),
        content: z.string().max(1000000),
      })
      .parse(
        (
          await board.api.rest.repos.getContent({
            ...board.scope,
            path: entry.path,
            ref: 'main',
          })
        ).data,
      );
    snapshot.sessions.push({
      file: entry.path,
      text: Buffer.from(file.content, 'base64').toString('utf8'),
    });
  }
  try {
    snapshot.local_proposals = proposalCsv(
      await readFile(
        path.join(path.resolve(directory), 'ai-proposals.csv'),
        'utf8',
      ),
    );
  } catch (error) {
    if (!errorCode(error, 'ENOENT')) throw error;
  }
  return writeExports(
    directory,
    buildExports(
      board.config,
      snapshot,
      assets,
      generatedAt ?? new Date().toISOString(),
    ),
  );
}

export async function publishExports(
  board: Board,
  directory: string,
): Promise<{ url: string; sha: string }> {
  const latest = path.join(path.resolve(directory), 'latest');
  if (!(await ownedSnapshot(latest)))
    throw new ExportError('No verified export snapshot exists.');
  const manifest = exportManifestSchema.parse(
    JSON.parse(await readFile(path.join(latest, 'manifest.json'), 'utf8')),
  );
  for (const csv of exportCsvSchema.options)
    if (!manifest.sha256[csv])
      throw new ExportError(`The manifest is missing ${csv}.`);
  const files = new Map<string, Buffer>();
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const bytes = await readFile(path.join(latest, file));
    if (hash(bytes) !== expected)
      throw new ExportError(`Export hash changed before publication: ${file}.`);
    files.set(file, bytes);
  }
  files.set(
    'manifest.json',
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  );
  const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
  let previous: string | undefined;
  try {
    previous = z.object({ object: z.object({ sha: gitSha }) }).parse(
      (
        await board.api.rest.git.getRef({
          ...board.scope,
          ref: 'heads/exports',
        })
      ).data,
    ).object.sha;
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ))
      throw error;
  }
  let base: string | undefined;
  const tree: {
    path: string;
    mode: '100644';
    type: 'blob';
    sha: string | null;
  }[] = [];
  if (previous) {
    base = z.object({ tree: z.object({ sha: gitSha }) }).parse(
      (
        await board.api.rest.git.getCommit({
          ...board.scope,
          commit_sha: previous,
        })
      ).data,
    ).tree.sha;
    const existing = z
      .object({
        truncated: z.boolean(),
        tree: z.array(
          z.object({ path: z.string(), type: z.string(), sha: gitSha }),
        ),
      })
      .parse(
        (
          await board.api.rest.git.getTree({
            ...board.scope,
            tree_sha: base,
            recursive: '1',
          })
        ).data,
      );
    if (existing.truncated)
      throw new ExportError(
        'Export history tree is truncated; split the engagement repository.',
      );
    for (const entry of existing.tree) {
      const prefix = [
        'exports/latest/',
        `exports/${manifest.generated_at.slice(0, 10)}/`,
      ].find((folder) => entry.path.startsWith(folder));
      if (entry.type !== 'blob' || !prefix) continue;
      const file = entry.path.slice(prefix.length);
      if (file !== 'manifest.json') exportFileSchema.parse(file);
      if (!files.has(file))
        tree.push({
          path: entry.path,
          mode: '100644',
          type: 'blob',
          sha: null,
        });
    }
  }
  for (const [file, bytes] of files) {
    const blob = z.object({ sha: gitSha }).parse(
      (
        await board.api.rest.git.createBlob({
          ...board.scope,
          encoding: 'base64',
          content: bytes.toString('base64'),
        })
      ).data,
    );
    for (const folder of ['latest', manifest.generated_at.slice(0, 10)])
      tree.push({
        path: `exports/${folder}/${file}`,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
  }
  const built = z.object({ sha: gitSha }).parse(
    (
      await board.api.rest.git.createTree({
        ...board.scope,
        ...(base ? { base_tree: base } : {}),
        tree,
      })
    ).data,
  );
  const commit = z.object({ sha: gitSha }).parse(
    (
      await board.api.rest.git.createCommit({
        ...board.scope,
        tree: built.sha,
        parents: previous ? [previous] : [],
        message: 'chore: publish audited export snapshots [skip ci]',
      })
    ).data,
  );
  const response = previous
    ? await board.api.rest.git.updateRef({
        ...board.scope,
        ref: 'heads/exports',
        sha: commit.sha,
        force: false,
      })
    : await board.api.rest.git.createRef({
        ...board.scope,
        ref: 'refs/heads/exports',
        sha: commit.sha,
      });
  const published = z
    .object({
      ref: z.literal('refs/heads/exports'),
      object: z.object({ sha: gitSha }),
    })
    .parse(response.data);
  if (published.object.sha !== commit.sha)
    throw new ExportError(
      'GitHub did not confirm the export commit; check the branch before retrying.',
    );
  return {
    url: `https://github.com/${board.config.board_repo}/tree/exports/exports/latest`,
    sha: commit.sha,
  };
}
