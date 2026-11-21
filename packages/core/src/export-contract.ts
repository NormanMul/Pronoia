import { z } from 'zod';
import { issueSchema, commentSchema } from './github.js';
import { evidenceSchema } from './evidence.js';

export const exportHeaders = {
  'findings.csv': [
    'issue',
    'url',
    'assessment',
    'milestone',
    'test_id',
    'title',
    'category',
    'source',
    'severity',
    'priority',
    'cve_ids',
    'cvss',
    'epss',
    'kev',
    'status',
    'resolution',
    'owner',
    'created_at',
    'updated_at',
    'due_date',
    'sla_breached',
    'confirmed_by',
    'validation_requested_by',
    'validated_by',
    'validated_by_name',
    'validated_at',
    'disputed_by',
    'dispute_type',
    'dispute_reason',
    'risk_until',
    'reject_count',
    'last_reject_reason',
    'last_reject_by',
    'blocked_reason',
    'test_description',
    'procedure',
    'expected_result',
    'actual_result',
    'remediation',
    'evidence_count',
    'evidence_files',
    'evidence_urls',
    'linked_prs',
  ],
  'decisions.csv': [
    'issue',
    'at',
    'actor',
    'actor_type',
    'on_behalf_of',
    'command',
    'from_status',
    'to_status',
    'reason',
    'evidence_count',
  ],
  'evidence.csv': [
    'issue',
    'file',
    'url',
    'sha256',
    'captured_at',
    'captured_by',
    'source',
    'session',
    'step',
    'note',
  ],
  'sessions.csv': [
    'session_id',
    'title',
    'started_at',
    'ended_at',
    'assessment',
    'items_touched',
    'recap_file',
  ],
  'ai-proposals.csv': [
    'at',
    'session',
    'agent',
    'issue',
    'proposal',
    'proposed_command',
    'confidence',
    'outcome',
    'reviewer',
    'reason',
  ],
  'status-history.csv': ['date', 'assessment', 'status', 'count'],
} as const;
export type ExportCsv = keyof typeof exportHeaders;
export const exportCsvSchema = z.enum([
  'findings.csv',
  'decisions.csv',
  'evidence.csv',
  'sessions.csv',
  'ai-proposals.csv',
  'status-history.csv',
]);

export const sessionFileSchema = z
  .string()
  .regex(/^sessions\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]{1,200}\.md$/);
export const exportFileSchema = z.union([
  exportCsvSchema,
  evidenceSchema.shape.file,
  sessionFileSchema,
]);
export const sessionRecordSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    started_at: z.iso.datetime(),
    ended_at: z.iso.datetime().nullable(),
    assessment: z.string().min(1).max(200),
    items_touched: z.array(z.number().int().positive()).max(100),
    recap_file: sessionFileSchema,
  })
  .strict();
export const proposalOutcomeSchema = z
  .object({
    id: z.uuid().optional(),
    at: z.iso.datetime(),
    session: z.string().min(1).max(200),
    agent: z.string().min(1).max(100),
    issue: z.number().int().positive().nullable(),
    proposal: z.string().max(50000),
    proposed_command: z.enum([
      'none',
      '/start',
      '/validate',
      '/block',
      '/confirm',
    ]),
    confidence: z.number().min(0).max(1),
    outcome: z.enum(['accepted', 'edited', 'discarded']),
    reviewer: z.string().min(1).max(100),
    reason: z.string().max(10000),
  })
  .strict();
export type ProposalExport = z.infer<typeof proposalOutcomeSchema>;
export const exportSnapshotSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            issue: issueSchema,
            comments: z.array(commentSchema).max(10000),
          })
          .strict(),
      )
      .max(10000),
    sessions: z
      .array(
        z
          .object({
            file: sessionFileSchema,
            text: z.string().max(500000),
          })
          .strict(),
      )
      .max(10000)
      .default([]),
    local_proposals: z.array(proposalOutcomeSchema).max(10000).default([]),
  })
  .strict();
export type ExportSnapshot = z.infer<typeof exportSnapshotSchema>;

export const exportManifestSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.iso.datetime(),
    period: z
      .object({
        start: z.iso.datetime(),
        end: z.iso.datetime(),
      })
      .strict()
      .refine((period) => period.start <= period.end, 'Invalid export period.'),
    row_counts: z
      .object({
        'findings.csv': z.number().int().nonnegative(),
        'decisions.csv': z.number().int().nonnegative(),
        'evidence.csv': z.number().int().nonnegative(),
        'sessions.csv': z.number().int().nonnegative(),
        'ai-proposals.csv': z.number().int().nonnegative(),
        'status-history.csv': z.number().int().nonnegative(),
      })
      .strict(),
    sha256: z.record(exportFileSchema, z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export const exportResultSchema = z
  .object({
    directory: z.string().min(1),
    manifest: exportManifestSchema,
  })
  .strict();
export type ExportResult = z.infer<typeof exportResultSchema>;
