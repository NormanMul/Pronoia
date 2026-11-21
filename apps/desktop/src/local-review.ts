import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseCsv, repoSchema, stringifyCsv } from '@pronoia/core';
import { budgetSnapshotSchema } from './budget';
import {
  proposalSchema,
  queuedProposalSchema,
  snapshotSchema,
  startSchema,
  transcriptSchema,
} from './shared';
import { DesktopError } from './safety';

const actionBase = z.object({
  id: z.uuid(),
  repo: repoSchema,
  actor: z.string().min(1).max(100),
  session: z.uuid().nullable(),
  synthetic: z.boolean(),
  at: z.iso.datetime(),
});
export const reviewedActionSchema = z.discriminatedUnion('kind', [
  actionBase
    .extend({
      kind: z.literal('manual'),
      issue: z.number().int().positive(),
      body: z.string().min(1).max(32000),
    })
    .strict(),
  actionBase
    .extend({
      kind: z.literal('evidence'),
      issue: z.number().int().positive(),
      capture: snapshotSchema,
      note: z.string().max(10000),
      step: z.string().max(200),
    })
    .strict(),
  actionBase
    .extend({
      kind: z.literal('proposal'),
      issue: z.number().int().positive(),
      capture: snapshotSchema,
      proposal: proposalSchema,
      outcome: z.enum(['accepted', 'edited']),
    })
    .strict(),
  actionBase
    .extend({
      kind: z.literal('recap'),
      text: z.string().min(1).max(32000),
      startedAt: z.iso.datetime(),
      items: z.array(z.number().int().positive()).max(100),
    })
    .strict(),
]);
export type ReviewedAction = z.infer<typeof reviewedActionSchema>;
export const savedSessionSchema = z
  .object({
    id: z.uuid(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    input: startSchema,
    sourceName: z.string(),
    segments: z.array(transcriptSchema).max(10000),
    touched: z.array(z.number().int().positive()).max(100),
    budget: budgetSnapshotSchema,
    recap: z.string().max(32000).nullable(),
  })
  .strict();
const outcomeSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    repo: repoSchema,
    session: z.uuid(),
    agent: z.literal('Analyst'),
    issue: z.number().int().positive().nullable(),
    proposal: z.string().max(50000),
    proposedCommand: z.string().max(30),
    confidence: z.number().min(0).max(1),
    outcome: z.enum(['accepted', 'edited', 'discarded']),
    reviewer: z.string(),
    reason: z.string().max(10000),
  })
  .strict();
export type ProposalOutcome = z.infer<typeof outcomeSchema>;
const reviewStateSchema = z
  .object({
    version: z.literal(1),
    session: savedSessionSchema.nullable(),
    proposals: z
      .array(
        z
          .object({ queued: queuedProposalSchema, capture: snapshotSchema })
          .strict(),
      )
      .max(20),
    publications: z
      .array(
        z
          .object({ action: reviewedActionSchema, url: z.url().nullable() })
          .strict(),
      )
      .max(10000),
    outcomes: z.array(outcomeSchema).max(10000),
  })
  .strict();
type ReviewState = z.infer<typeof reviewStateSchema>;

export async function atomicWrite(
  filename: string,
  contents: string | Buffer,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanup) {
      if (!(
        typeof cleanup === 'object' &&
        cleanup !== null &&
        'code' in cleanup &&
        cleanup.code === 'ENOENT'
      )) {
        throw new AggregateError(
          [error, cleanup],
          'The atomic write and temporary-file cleanup failed.',
        );
      }
    }
    throw error;
  }
}

export async function prunePrivateFiles(
  folder: string,
  retentionDays: number,
  at = Date.now(),
): Promise<void> {
  z.number().int().min(1).max(365).parse(retentionDays);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const namespaces = [
    {
      directory: folder,
      pattern: new RegExp(`^(?:review\\.json|settings\\.bin)\\.${uuid}\\.tmp$`),
    },
    {
      directory: path.join(folder, 'sessions'),
      pattern: new RegExp(`^${uuid}\\.json(?:\\.${uuid}\\.tmp)?$`),
    },
    {
      directory: path.join(folder, 'captures'),
      pattern: new RegExp(`^${uuid}--${uuid}\\.png(?:\\.${uuid}\\.tmp)?$`),
    },
  ];
  const cutoff = at - retentionDays * 86400000;
  for (const namespace of namespaces) {
    let entries;
    try {
      entries = await readdir(namespace.directory, { withFileTypes: true });
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !namespace.pattern.test(entry.name)) continue;
      const filename = path.join(namespace.directory, entry.name);
      if ((await stat(filename)).mtimeMs < cutoff) await unlink(filename);
    }
  }
}

async function appendCsvRow(
  filename: string,
  headers: string[],
  row: (string | number | boolean | null)[],
): Promise<void> {
  if (row.length !== headers.length)
    throw new DesktopError(
      'EXPORT_SCHEMA',
      'The export row does not match its schema.',
    );
  let contents: string;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
    contents = '\uFEFF' + stringifyCsv([headers]);
  }
  const rows = parseCsv(contents);
  if (
    JSON.stringify(rows[0]) !== JSON.stringify(headers) ||
    rows.some((row) => row.length !== headers.length)
  ) {
    throw new DesktopError(
      'EXPORT_SCHEMA',
      'The existing export schema differs; no outcomes were overwritten.',
    );
  }
  const encoded = stringifyCsv([row]);
  const expected = parseCsv(encoded)[0];
  if (
    rows
      .slice(1)
      .some((row) => JSON.stringify(row) === JSON.stringify(expected))
  )
    return;
  await atomicWrite(
    filename,
    contents + (contents.endsWith('\n') ? '' : '\r\n') + encoded,
  );
}

const csvWrites = new Map<string, Promise<void>>();
export function appendCsvOnce(
  filename: string,
  headers: string[],
  row: (string | number | boolean | null)[],
): Promise<void> {
  const key =
    process.platform === 'win32'
      ? path.resolve(filename).toLowerCase()
      : path.resolve(filename);
  const previous = csvWrites.get(key) ?? Promise.resolve();
  const write = () => appendCsvRow(filename, headers, row);
  const operation = previous.then(write, write);
  csvWrites.set(key, operation);
  const release = () => {
    if (csvWrites.get(key) === operation) csvWrites.delete(key);
  };
  void operation.then(release, release);
  return operation;
}

export class LocalReviewJournal {
  private writes: Promise<void> = Promise.resolve();
  private constructor(
    readonly folder: string,
    readonly state: ReviewState,
  ) {}

  static async open(folder: string): Promise<LocalReviewJournal> {
    const filename = path.join(folder, 'review.json');
    let contents: string;
    try {
      if ((await stat(filename)).size > 350 * 1024 * 1024) {
        throw new DesktopError(
          'RECOVERY_SIZE',
          'Local recovery data exceeds the configured safety boundary.',
        );
      }
      contents = await readFile(filename, 'utf8');
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      return new LocalReviewJournal(folder, {
        version: 1,
        session: null,
        proposals: [],
        publications: [],
        outcomes: [],
      });
    }
    return new LocalReviewJournal(
      folder,
      reviewStateSchema.parse(JSON.parse(contents)),
    );
  }

  save(): Promise<void> {
    const contents = JSON.stringify(reviewStateSchema.parse(this.state));
    const write = () =>
      atomicWrite(path.join(this.folder, 'review.json'), contents);
    const operation = this.writes.then(write, write);
    this.writes = operation;
    return operation;
  }

  async begin(action: ReviewedAction, prevalidate?: () => Promise<void>) {
    const validated = reviewedActionSchema.parse(action);
    let entry = this.state.publications.find(
      (entry) => entry.action.id === validated.id,
    );
    if (entry && JSON.stringify(entry.action) !== JSON.stringify(validated)) {
      throw new DesktopError(
        'PUBLICATION_CHANGED',
        'A pending publication is immutable. Retry the reviewed content before editing it.',
      );
    }
    if (!entry) {
      if (prevalidate) await prevalidate();
      entry = { action: validated, url: null };
      this.state.publications.push(entry);
    }
    await this.save();
    return entry;
  }

  expire(retentionDays: number, at = Date.now()): void {
    z.number().int().min(1).max(365).parse(retentionDays);
    const cutoff = at - retentionDays * 86400000;
    if (this.state.session && Date.parse(this.state.session.startedAt) < cutoff)
      this.state.session = null;
    this.state.proposals = this.state.proposals.filter(
      (entry) => Date.parse(entry.capture.capturedAt) >= cutoff,
    );
    this.state.publications = this.state.publications.filter(
      (entry) => Date.parse(entry.action.at) >= cutoff,
    );
    this.state.outcomes = this.state.outcomes.filter(
      (entry) => Date.parse(entry.at) >= cutoff,
    );
  }

  async finish(id: string, url: string): Promise<void> {
    const entry = this.state.publications.find(
      (entry) => entry.action.id === id,
    );
    if (!entry)
      throw new DesktopError(
        'PUBLICATION',
        'This reviewed publication is unavailable.',
      );
    const previous = entry.url;
    entry.url = z.url().parse(url);
    try {
      await this.save();
    } catch (error) {
      entry.url = previous;
      throw error;
    }
  }
}
