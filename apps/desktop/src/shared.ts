import { z } from 'zod';

export const errorSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict();
export type Reply<T> =
  { ok: true; value: T } | { ok: false; error: z.infer<typeof errorSchema> };
export const phaseSchema = z.enum([
  'idle',
  'starting',
  'active',
  'paused',
  'stopped',
]);
export const publicSettingsSchema = z
  .object({
    endpoint: z.string(),
    chatDeployment: z.string(),
    transcribeDeployment: z.string(),
    realtimeDeployment: z.string(),
    githubRepo: z.string(),
    exportDir: z.string(),
    authMode: z.enum(['identity', 'key']).default('identity'),
    retentionDays: z.number().int().min(1).max(365).default(30),
    maxImagesPerSession: z.number().int().min(1).max(1000).default(60),
    maxAnalysesPerMinute: z.number().int().min(1).max(6).default(3),
    maxTokensPerSession: z
      .number()
      .int()
      .min(16000)
      .max(1000000)
      .default(100000),
    hotkeys: z
      .object({
        evidence: z.string().min(1).max(80).default('Ctrl+Alt+E'),
        ask: z.string().min(1).max(80).default('Ctrl+Alt+A'),
        pause: z.string().min(1).max(80).default('Ctrl+Alt+P'),
        presenter: z.string().min(1).max(80).default('Ctrl+Alt+B'),
      })
      .strict()
      .prefault({}),
    hasKey: z.boolean(),
    hasGitHubToken: z.boolean(),
  })
  .strict();
export const settingsInputSchema = publicSettingsSchema
  .omit({ hasKey: true, hasGitHubToken: true })
  .extend({
    apiKey: z.string().max(4096).optional(),
    githubToken: z.string().max(4096).optional(),
  })
  .strict();
export const startSchema = z
  .object({
    participantsNotified: z.boolean(),
    cloudApproved: z.boolean(),
    synthetic: z.boolean(),
    sourceId: z.string().min(1).max(256),
    assessment: z.string().max(200),
    issues: z
      .array(z.number().int().positive())
      .max(100)
      .refine(
        (issues) => new Set(issues).size === issues.length,
        'Select each finding only once.',
      ),
    microphone: z.boolean(),
    systemAudio: z.boolean(),
    provider: z.enum(['batch', 'realtime']),
    autoWatch: z.boolean(),
  })
  .strict();
export const audioSchema = z
  .object({
    session: z.string().min(1),
    capture: z.uuid(),
    source: z.enum(['You', 'Meeting']),
    startedAt: z.iso.datetime().optional(),
    bytes: z
      .instanceof(ArrayBuffer)
      .refine(
        (bytes) => bytes.byteLength > 0 && bytes.byteLength <= 5 * 1024 * 1024,
      ),
  })
  .strict();
export const proposalSchema = z
  .object({
    issue: z.number().int().positive().nullable(),
    observed: z.string().max(10000),
    result: z.enum(['pass', 'fail', 'unclear', 'n/a']),
    proposed_command: z.enum([
      '/start',
      '/validate',
      '/block',
      '/confirm',
      'none',
    ]),
    reason: z.string().max(10000),
    remediation: z.array(z.string().max(2000)).max(7),
    evidence_note: z.string().max(10000),
    verbal_decision: z
      .object({
        type: z.enum(['approve', 'reject', 'dispute', 'none']),
        speaker: z.string(),
        quote: z.string(),
        at: z.string(),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const postProposalSchema = z
  .object({
    id: z.string(),
    issue: z.number().int().positive(),
    proposal: proposalSchema,
    reviewed: z.literal(true),
  })
  .strict()
  .refine(
    (input) => input.issue === input.proposal.issue,
    'The proposal and publication must refer to the same finding.',
  );
export const snapshotSchema = z
  .object({
    id: z.string(),
    image: z.string().max(15 * 1024 * 1024),
    capturedAt: z.iso.datetime(),
    source: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    transcript: z.string(),
  })
  .strict();
export const analyseSchema = z
  .object({
    snapshot: z.string(),
    png: z.string().max(15 * 1024 * 1024),
    transcript: z.string().max(32000),
    reviewed: z.literal(true),
    issue: z.number().int().positive().optional(),
  })
  .strict();
export const cardSchema = z
  .object({
    number: z.number().int().positive(),
    updatedAt: z.string(),
    title: z.string(),
    status: z.enum(['todo', 'in-progress', 'validate', 'blocked', 'done']),
    severity: z.string(),
    priority: z.string(),
    assessment: z.string(),
    body: z.string(),
    url: z.string(),
    assignees: z.array(z.string()),
    validationRequestedBy: z.string().nullable(),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();
export const transcriptSchema = z
  .object({
    at: z.iso.datetime(),
    source: z.enum(['You', 'Meeting']),
    text: z.string(),
    id: z.string().optional(),
    final: z.boolean().optional(),
  })
  .strict();
export const queuedProposalSchema = z
  .object({
    id: z.string(),
    snapshot: z.string(),
    image: z.string().max(15 * 1024 * 1024),
    proposal: proposalSchema,
    warnings: z.array(z.string()),
  })
  .strict();
export const manualInputSchema = z
  .object({
    id: z.uuid(),
    issue: z.number().int().positive(),
    body: z.string().trim().min(1).max(32000),
    reviewed: z.literal(true),
  })
  .strict();
export const publishEvidenceSchema = analyseSchema
  .extend({
    id: z.uuid(),
    issue: z.number().int().positive(),
    note: z.string().max(10000),
    step: z.string().max(200).default(''),
  })
  .strict();
export const evidencePreviewSchema = z
  .object({
    issue: z.number().int().positive(),
    file: z
      .string()
      .regex(/^evidence\/[1-9]\d*\/\d{8}T\d{6}Z-[a-f0-9]{8}\.png$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const detailEvidenceSchema = z
  .object({
    file: z.string(),
    url: z.url(),
    sha256: z.string(),
    capturedAt: z.string(),
    capturedBy: z.string(),
    source: z.string(),
    session: z.string(),
    step: z.string(),
    note: z.string(),
  })
  .strict();
export const itemDetailSchema = z
  .object({
    card: cardSchema,
    test: z.string(),
    procedure: z.string(),
    expected: z.string(),
    actual: z.string(),
    remediation: z.array(z.string()),
    comments: z.array(
      z
        .object({
          id: z.number().int().positive(),
          actor: z.string(),
          at: z.string(),
          body: z.string(),
          url: z.url(),
        })
        .strict(),
    ),
    trail: z.array(
      z
        .object({
          at: z.string(),
          from: z.string(),
          to: z.string(),
          command: z.string(),
          actor: z.string(),
          actorType: z.enum(['human', 'agent', 'automation']),
          onBehalfOf: z.string(),
          reason: z.string(),
          evidenceCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    evidence: z.array(detailEvidenceSchema),
    warnings: z.array(z.string()),
  })
  .strict();
export const recoverySchema = z
  .object({
    session: z.string().nullable(),
    phase: phaseSchema,
    proposals: z.array(queuedProposalSchema),
    recap: z.string().nullable(),
    pending: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(['manual', 'proposal', 'evidence', 'recap']),
            issue: z.number().int().positive().nullable(),
            actor: z.string(),
            text: z.string(),
            image: z
              .string()
              .max(15 * 1024 * 1024)
              .nullable()
              .default(null),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const recapResultSchema = z
  .object({ session: z.uuid(), text: z.string().max(32000) })
  .strict();
export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('phase'),
    phase: phaseSchema,
    session: z.string().nullable(),
  }),
  z.object({ type: z.literal('transcript'), segment: transcriptSchema }),
  z.object({ type: z.literal('notice'), error: errorSchema }),
  z.object({ type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ type: z.literal('proposal'), proposal: queuedProposalSchema }),
  z.object({ type: z.literal('request-capture') }),
  z.object({ type: z.literal('request-ask') }),
  z.object({ type: z.literal('request-pause') }),
  z.object({ type: z.literal('request-presenter') }),
  z.object({ type: z.literal('fallback-batch'), message: z.string() }),
]);
export type Settings = z.infer<typeof publicSettingsSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Start = z.infer<typeof startSchema>;
export type AppEvent = z.infer<typeof eventSchema>;
export type QueuedProposal = z.infer<typeof queuedProposalSchema>;
export type Segment = z.infer<typeof transcriptSchema>;
export type ItemDetail = z.infer<typeof itemDetailSchema>;

export interface PronoiaApi {
  settings(): Promise<Reply<Settings>>;
  saveSettings(
    input: z.infer<typeof settingsInputSchema>,
  ): Promise<Reply<Settings>>;
  board(): Promise<
    Reply<{ cards: Card[]; login: string; publicRepo: boolean }>
  >;
  item(issue: number): Promise<Reply<ItemDetail>>;
  evidencePreview(
    input: z.infer<typeof evidencePreviewSchema>,
  ): Promise<Reply<string>>;
  publishEvidence(
    input: z.infer<typeof publishEvidenceSchema>,
  ): Promise<Reply<{ url: string }>>;
  recovery(): Promise<Reply<z.infer<typeof recoverySchema>>>;
  retryPublication(input: {
    id: string;
    reviewed: true;
  }): Promise<Reply<{ url: string }>>;
  sources(): Promise<Reply<{ id: string; name: string }[]>>;
  copyNotice(language: 'en' | 'id'): Promise<Reply<void>>;
  start(input: Start): Promise<Reply<{ session: string; platform: string }>>;
  activate(session: string): Promise<Reply<void>>;
  mediaToken(session: string): Promise<Reply<string>>;
  stop(): Promise<Reply<void>>;
  pause(paused: boolean): Promise<Reply<void>>;
  audio(input: z.infer<typeof audioSchema>): Promise<Reply<void>>;
  pcm(input: z.infer<typeof audioSchema>): Promise<Reply<void>>;
  snapshot(): Promise<Reply<Snapshot>>;
  analyse(input: z.infer<typeof analyseSchema>): Promise<Reply<QueuedProposal>>;
  ask(input: {
    snapshot: string;
    png: string;
    transcript: string;
    question: string;
    reviewed: true;
    issue?: number;
  }): Promise<Reply<string>>;
  post(
    input: z.infer<typeof postProposalSchema>,
  ): Promise<Reply<{ url: string }>>;
  discard(input: { id: string; reason: string }): Promise<Reply<void>>;
  manual(
    input: z.infer<typeof manualInputSchema>,
  ): Promise<Reply<{ url: string }>>;
  recap(): Promise<Reply<z.infer<typeof recapResultSchema>>>;
  publishRecap(input: {
    session: string;
    text: string;
    reviewed: true;
  }): Promise<Reply<{ url: string }>>;
  presenter(enabled: boolean): Promise<Reply<void>>;
  compact(enabled: boolean): Promise<Reply<void>>;
  alwaysOnTop(enabled: boolean): Promise<Reply<void>>;
  open(url: string): Promise<Reply<void>>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}

declare global {
  interface Window {
    pronoia: PronoiaApi;
  }
}
