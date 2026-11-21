import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  dialog,
  safeStorage,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import OpenAI from 'openai';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import {
  Board,
  configSchema,
  createGitHubClient,
  expectedState,
  readMeta,
  issueSchema,
  validatePng,
  nextState,
  parseCommand,
  marker,
  CommandError,
  EvidenceError,
  evidencePath,
  FoundryService,
  createFoundryClient,
  foundryConfigSchema,
  azureEndpointSchema,
  repoSchema,
  type AiResult,
  type Config,
  type Issue,
  type RoleContext,
  type RealtimeHandle,
  type Role,
  type RoleInput,
  type RoleOutput,
  exportBoard,
} from '@pronoia/core';
import {
  audioSchema,
  analyseSchema,
  eventSchema,
  evidencePreviewSchema,
  manualInputSchema,
  phaseSchema,
  postProposalSchema,
  publicSettingsSchema,
  publishEvidenceSchema,
  settingsInputSchema,
  startSchema,
  type AppEvent,
  type Card,
  type QueuedProposal,
  type Segment,
  type Snapshot,
} from './shared';
import {
  allowedExternalUrl,
  DesktopError,
  redactText,
  requireConsent,
  requirePublication,
  requireCurrentOperation,
  requireCaptureToken,
  screenChanged,
} from './safety';
import { PcmBuffer } from './realtime-buffer';
import { SessionBudget } from './budget';
import { buildCard, buildItemDetail } from './item-detail';
import {
  appendCsvOnce,
  atomicWrite,
  LocalReviewJournal,
  prunePrivateFiles,
  type ReviewedAction,
  type ProposalOutcome,
} from './local-review';
import {
  pendingReviewText,
  postReviewedComment,
  PublicationLock,
  proposalLog,
  proposalMarker,
} from './publication';
import { formatRecap } from './recap';

const notice = {
  en: 'This Pronoia session transcribes microphone/system audio and captures screenshots. Audio is processed by Microsoft Foundry; raw audio is not stored. Screenshots and excerpts are reviewed/redacted before AI analysis or publication. Every assessment decision requires human confirmation. Tell all participants before starting.',
  id: 'Sesi Pronoia ini mentranskripsikan mikrofon/audio sistem dan mengambil tangkapan layar. Audio diproses oleh Microsoft Foundry; audio mentah tidak disimpan. Gambar dan kutipan ditinjau/disunting sebelum analisis AI atau publikasi. Setiap keputusan asesmen memerlukan konfirmasi manusia. Beri tahu semua peserta sebelum mulai.',
};
const privateSettingsSchema = settingsInputSchema.extend({
  apiKey: z.string().default(''),
  githubToken: z.string().default(''),
});
type PrivateSettings = z.infer<typeof privateSettingsSchema>;
type Session = {
  id: string;
  startedAt: string;
  phase: z.infer<typeof phaseSchema>;
  input: z.infer<typeof startSchema>;
  sourceName: string;
  segments: Segment[];
  controller: AbortController;
  audioPending: number;
  budget: SessionBudget;
  endedAt: string | null;
  touched: Set<number>;
  recap: string | null;
  usageWarning: boolean;
  capture: string;
  watchTimer?: ReturnType<typeof setInterval>;
  previousFrame?: Uint8Array;
};
let window: BrowserWindow | undefined;
let settings: PrivateSettings;
let policy = configSchema.parse({});
let journal: LocalReviewJournal;
let boardClient: Board | undefined;
let login = '';
let publicRepo = true;
let session: Session | undefined;
const captures = new Map<string, Snapshot>();
const proposals = new Map<string, QueuedProposal>();
const proposalCaptures = new Map<string, Snapshot>();
const cards = new Map<number, { updatedAt: string; card: Card }>();
let boardEtag = '';
let captureBusy = false;
let foundry: FoundryService | undefined;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicationLock = new PublicationLock();
let starting = false;
let startController: AbortController | undefined;
let recapController: AbortController | undefined;
let analysisBusy = false;
const realtime = new Map<
  'You' | 'Meeting',
  {
    handle: RealtimeHandle;
    pending: boolean;
    ready: boolean;
    timer: ReturnType<typeof setInterval>;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const queuedPcm = new Map<'You' | 'Meeting', PcmBuffer>();
const reconnects = new Map<'You' | 'Meeting', number>();
const store = () => path.join(app.getPath('userData'), 'pronoia');

function publicSettings() {
  const { apiKey, githubToken, ...visible } = settings;
  return publicSettingsSchema.parse({
    ...visible,
    hasKey: Boolean(apiKey),
    hasGitHubToken: Boolean(githubToken),
  });
}

function closeRealtime() {
  for (const channel of realtime.values()) {
    clearInterval(channel.timer);
    clearTimeout(channel.timeout);
    channel.handle.connection.close();
  }
  realtime.clear();
  queuedPcm.clear();
}

function fallbackBatch(message: string) {
  const active = currentSession();
  if (
    active.controller.signal.aborted ||
    !['starting', 'active'].includes(active.phase)
  )
    return;
  closeRealtime();
  active.input.provider = 'batch';
  emit({
    type: 'fallback-batch',
    message: `${message} Uncommitted realtime audio may be missing.`,
  });
}

async function realtimeChannel(source: 'You' | 'Meeting') {
  const active = currentSession();
  if (
    realtime.has(source) ||
    active.controller.signal.aborted ||
    active.input.provider !== 'realtime'
  )
    return;
  const result = await ai().openRealtime(() => {
    if (!active.controller.signal.aborted)
      emit({
        type: 'notice',
        error: {
          code: 'REALTIME',
          message: 'Realtime transcription reported a connection error.',
        },
      });
  }, active.controller.signal);
  if (!result.ok) {
    fallbackBatch(
      'Realtime transcription is unavailable; using complete batch clips.',
    );
    return;
  }
  const handle = result.value;
  const connection = handle.connection;
  if (
    active.controller.signal.aborted ||
    session !== active ||
    active.input.provider !== 'realtime'
  ) {
    connection.close();
    return;
  }
  const partial = new Map<string, Segment>();
  const signal = active.controller.signal;
  const timer = setInterval(() => {
    const channel = realtime.get(source);
    if (
      active.phase === 'active' &&
      channel?.ready &&
      channel.pending &&
      connection.socket.readyState === 1
    ) {
      try {
        // Realtime transcription does not report usage here; conservatively meter each audio commit.
        active.budget
          .claim({ tokens: 100, image: false, analysis: false })
          .complete(null);
        connection.send({ type: 'input_audio_buffer.commit' });
        channel.pending = false;
        if (!active.usageWarning) {
          active.usageWarning = true;
          emit({
            type: 'notice',
            error: {
              code: 'AI_USAGE_ESTIMATE',
              message:
                'Realtime commits count as 100 estimated token units per source. The session budget is not an invoice cap.',
            },
          });
        }
        void persistSession(active).catch((error: unknown) => {
          active.controller.abort();
          closeRealtime();
          if (session === active) setPhase('paused');
          emit({ type: 'notice', error: errorValue(error) });
        });
      } catch (error) {
        if (error instanceof DesktopError && error.code === 'AI_TOKEN_BUDGET') {
          active.controller.abort();
          closeRealtime();
          if (session === active) setPhase('paused');
          emit({ type: 'notice', error: errorValue(error) });
        } else fallbackBatch(errorValue(error).message);
      }
    }
  }, 3000);
  const timeout = setTimeout(() => {
    if (!signal.aborted && !realtime.get(source)?.ready)
      fallbackBatch(
        'Realtime configuration timed out; using complete batch clips.',
      );
  }, 15000);
  const channel = { handle, pending: false, ready: false, timer, timeout };
  realtime.set(source, channel);
  const configure = () => {
    if (
      signal.aborted ||
      realtime.get(source) !== channel ||
      active.input.provider !== 'realtime'
    )
      return;
    try {
      connection.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: null,
              transcription: { model: handle.transcription_model },
            },
          },
        },
      });
    } catch (error) {
      fallbackBatch(errorValue(error).message);
    }
  };
  connection.on('session.updated', (payload) => {
    if (signal.aborted || realtime.get(source) !== channel) return;
    const valid = z
      .object({ session: z.object({ type: z.literal('transcription') }) })
      .safeParse(payload);
    if (!valid.success) {
      fallbackBatch(
        'Realtime returned an invalid transcription configuration.',
      );
      return;
    }
    channel.ready = true;
    clearTimeout(timeout);
    try {
      if (
        queuedPcm.get(source)?.flush((bytes) =>
          connection.send({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(bytes).toString('base64'),
          }),
        )
      )
        channel.pending = true;
    } catch (error) {
      fallbackBatch(errorValue(error).message);
    }
  });
  if (connection.socket.readyState === 1) configure();
  else connection.socket.once('open', configure);
  connection.on(
    'conversation.item.input_audio_transcription.delta',
    (payload) => {
      if (
        signal.aborted ||
        realtime.get(source) !== channel ||
        active.input.provider !== 'realtime'
      )
        return;
      const parsed = z
        .object({ item_id: z.string().max(200), delta: z.string().max(10000) })
        .safeParse(payload);
      if (!parsed.success || partial.size > 100) {
        fallbackBatch(
          'Invalid or excessive realtime transcript output was refused.',
        );
        return;
      }
      const delta = parsed.data;
      const segment = partial.get(delta.item_id) || {
        at: new Date().toISOString(),
        source,
        id: `${source}:${delta.item_id}`,
        text: '',
        final: false,
      };
      if (segment.text.length + delta.delta.length > 50000) {
        fallbackBatch('Realtime transcript exceeded the size boundary.');
        return;
      }
      segment.text += delta.delta;
      partial.set(delta.item_id, segment);
      emit({ type: 'transcript', segment });
    },
  );
  connection.on(
    'conversation.item.input_audio_transcription.completed',
    (payload) => {
      if (
        signal.aborted ||
        realtime.get(source) !== channel ||
        active.input.provider !== 'realtime'
      )
        return;
      const parsed = z
        .object({
          item_id: z.string().max(200),
          transcript: z.string().max(50000),
        })
        .safeParse(payload);
      if (!parsed.success) {
        fallbackBatch('Invalid realtime transcript output was refused.');
        return;
      }
      const completed = parsed.data;
      const previous = partial.get(completed.item_id);
      const segment: Segment = {
        at: previous?.at || new Date().toISOString(),
        source,
        id: `${source}:${completed.item_id}`,
        text: completed.transcript,
        final: true,
      };
      partial.delete(completed.item_id);
      active.segments.push(segment);
      emit({ type: 'transcript', segment });
      void persistSession().catch((error: unknown) =>
        emit({ type: 'notice', error: errorValue(error) }),
      );
    },
  );
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
      clearTimeout(timeout);
      connection.close();
      if (realtime.get(source) === channel) realtime.delete(source);
    },
    { once: true },
  );
  connection.socket.once('close', () => {
    clearInterval(timer);
    clearTimeout(timeout);
    if (realtime.get(source) === channel) realtime.delete(source);
    if (signal.aborted || active.input.provider !== 'realtime') return;
    const attempts = (reconnects.get(source) || 0) + 1;
    reconnects.set(source, attempts);
    if (attempts > 3) {
      fallbackBatch(
        'Realtime reconnect limit reached; using batch transcription. Some uncommitted audio may be missing.',
      );
      return;
    }
    setTimeout(
      () => {
        if (!signal.aborted && active.input.provider === 'realtime')
          void realtimeChannel(source).catch((error: unknown) =>
            fallbackBatch(errorValue(error).message),
          );
      },
      1000 * 2 ** (attempts - 1),
    );
  });
}

async function pcm(input: z.infer<typeof audioSchema>) {
  const active = currentSession();
  requireCaptureToken(active.capture, input.capture);
  if (
    input.session !== active.id ||
    !['starting', 'active'].includes(active.phase) ||
    active.input.provider !== 'realtime'
  )
    throw new DesktopError(
      'CAPTURE_PAUSED',
      'PCM from a stopped or unconsented session was refused.',
    );
  const channel = realtime.get(input.source);
  if (
    (input.source === 'You' && !active.input.microphone) ||
    (input.source === 'Meeting' && !active.input.systemAudio)
  ) {
    throw new DesktopError(
      'CAPTURE_SOURCE',
      'This audio source was not consented for the session.',
    );
  }
  const buffer = queuedPcm.get(input.source) || new PcmBuffer();
  queuedPcm.set(input.source, buffer);
  try {
    buffer.append(new Uint8Array(input.bytes));
  } catch (error) {
    fallbackBatch(errorValue(error).message);
    throw error;
  }
  if (!channel?.ready || channel.handle.connection.socket.readyState !== 1)
    return;
  if (channel.handle.connection.socket.bufferedAmount > 2 * 1024 * 1024) {
    fallbackBatch('Realtime transport is behind; using bounded batch clips.');
    throw new DesktopError(
      'REALTIME_BACKPRESSURE',
      'Realtime audio transport is behind; the batch fallback was requested.',
    );
  }
  if (
    buffer.flush((bytes) =>
      channel.handle.connection.send({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(bytes).toString('base64'),
      }),
    )
  )
    channel.pending = true;
}

function errorValue(error: unknown) {
  if (error instanceof DesktopError)
    return { code: error.code, message: error.message };
  if (error instanceof CommandError || error instanceof EvidenceError)
    return { code: 'COMMAND_REFUSED', message: error.message };
  if (error instanceof z.ZodError) {
    console.error(
      'Pronoia schema validation failed:',
      error.issues.map(({ path, code }) => ({ path, code })),
    );
    return {
      code: 'INVALID_INPUT',
      message: 'The request did not match the permitted input schema.',
    };
  }
  console.error(
    'Pronoia request failed:',
    error instanceof Error ? error.name : 'UnknownError',
  );
  return {
    code: 'SERVICE_ERROR',
    message:
      'The operation failed. Check configuration, identity permissions and connectivity; no success is assumed.',
  };
}

function emit(event: AppEvent) {
  if (window && !window.isDestroyed())
    window.webContents.send('pronoia:event', eventSchema.parse(event));
}

function register<S extends z.ZodType, T>(
  action: string,
  schema: S,
  handler: (input: z.infer<S>) => Promise<T> | T,
) {
  ipcMain.handle(
    `pronoia:${action}`,
    async (event: IpcMainInvokeEvent, payload: unknown) => {
      try {
        if (
          !window ||
          event.sender.id !== window.webContents.id ||
          event.senderFrame?.url !== window.webContents.getURL()
        ) {
          throw new DesktopError(
            'IPC_ORIGIN',
            'Only the Pronoia main window may invoke this operation.',
          );
        }
        return { ok: true, value: await handler(schema.parse(payload)) };
      } catch (error) {
        return { ok: false, error: errorValue(error) };
      }
    },
  );
}

async function loadSettings() {
  const filename = path.join(store(), 'settings.bin');
  const defaults = privateSettingsSchema.parse({
    endpoint: process.env.AZURE_FOUNDRY_ENDPOINT || '',
    chatDeployment: process.env.FOUNDRY_CHAT_DEPLOYMENT || '',
    transcribeDeployment: process.env.FOUNDRY_TRANSCRIBE_DEPLOYMENT || '',
    realtimeDeployment:
      process.env.FOUNDRY_REALTIME_TRANSCRIBE_DEPLOYMENT || '',
    authMode: process.env.AZURE_AUTH_MODE || 'identity',
    githubRepo: process.env.PRONOIA_REPO || policy.board_repo,
    exportDir:
      process.env.PRONOIA_EXPORT_DIR ||
      path.join(app.getPath('documents'), 'Pronoia', 'exports'),
    retentionDays: policy.retention_days,
    maxImagesPerSession: policy.budgets.max_images_per_session,
    maxAnalysesPerMinute: policy.budgets.max_analyses_per_min,
    apiKey: process.env.AZURE_FOUNDRY_API_KEY || '',
    githubToken: process.env.GITHUB_TOKEN || '',
  });
  if (!existsSync(filename)) return defaults;
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text')
  ) {
    throw new DesktopError(
      'SECURE_STORAGE',
      'OS-backed encryption is unavailable. Credentials will not be read or stored in plaintext.',
    );
  }
  const decoded = await safeStorage.decryptStringAsync(
    await readFile(filename),
  );
  const loaded = privateSettingsSchema.parse(JSON.parse(decoded.result));
  if (!path.isAbsolute(loaded.exportDir))
    throw new DesktopError(
      'EXPORT_PATH',
      'Stored settings require an absolute export folder.',
    );
  if (decoded.shouldReEncrypt)
    await writeFile(
      filename,
      await safeStorage.encryptStringAsync(decoded.result),
    );
  return loaded;
}

async function saveSettings(input: z.infer<typeof settingsInputSchema>) {
  if (
    starting ||
    publicationLock.busy ||
    recapController ||
    (session && session.phase !== 'stopped')
  )
    throw new DesktopError(
      'SESSION_ACTIVE',
      'Stop the session before changing connection settings.',
    );
  if (
    proposals.size ||
    journal.state.publications.some((entry) => entry.url === null)
  )
    throw new DesktopError(
      'PENDING_PROPOSALS',
      'Review/discard pending proposals before changing repository or model settings.',
    );
  if (input.endpoint) azureEndpointSchema.parse(input.endpoint);
  repoSchema.parse(input.githubRepo);
  if (!path.isAbsolute(input.exportDir))
    throw new DesktopError(
      'EXPORT_PATH',
      'Choose an absolute local/OneDrive export folder.',
    );
  if (
    new Set(Object.values(input.hotkeys).map((key) => key.toLowerCase()))
      .size !== 4
  ) {
    throw new DesktopError(
      'SHORTCUT',
      'Use a different accelerator for each shortcut.',
    );
  }
  return publicationLock.run(async () => {
    if (
      !(await safeStorage.isAsyncEncryptionAvailable()) ||
      (process.platform === 'linux' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new DesktopError(
        'SECURE_STORAGE',
        'OS-backed encrypted credential storage is required.',
      );
    }
    const next = privateSettingsSchema.parse({
      ...input,
      apiKey: input.apiKey === undefined ? settings.apiKey : input.apiKey,
      githubToken:
        input.githubToken === undefined
          ? settings.githubToken
          : input.githubToken,
    });
    await mkdir(store(), { recursive: true });
    await atomicWrite(
      path.join(store(), 'settings.bin'),
      await safeStorage.encryptStringAsync(JSON.stringify(next)),
    );
    settings = next;
    if (session) {
      await persistSession(session);
      session.controller.abort();
      session = undefined;
      captures.clear();
      proposalCaptures.clear();
      journal.state.session = null;
      await journal.save();
      setPhase('idle');
    }
    boardClient = undefined;
    foundry = undefined;
    cards.clear();
    boardEtag = '';
    configureHotkeys();
    return publicSettings();
  });
}

function config(): Config {
  return configSchema.parse({
    ...policy,
    board_repo: settings.githubRepo,
    export: { dir: settings.exportDir },
    budgets: {
      max_analyses_per_min: settings.maxAnalysesPerMinute,
      max_images_per_session: settings.maxImagesPerSession,
    },
    retention_days: settings.retentionDays,
  });
}

function board() {
  if (!boardClient) {
    let token = settings.githubToken;
    if (!token) {
      try {
        token = execFileSync('gh', ['auth', 'token'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15000,
        }).trim();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new DesktopError(
          'GITHUB_AUTH',
          'Run gh auth login or enter a fine-grained PAT in encrypted Settings.',
        );
      }
    }
    if (!token)
      throw new DesktopError(
        'GITHUB_AUTH',
        'A personal GitHub credential is required.',
      );
    boardClient = new Board(createGitHubClient(token), config());
  }
  return boardClient;
}

async function refreshBoard() {
  const client = board();
  const user = z
    .object({ login: z.string(), type: z.string() })
    .parse((await client.api.rest.users.getAuthenticated()).data);
  if (user.type !== 'User')
    throw new DesktopError(
      'HUMAN_AUTH',
      'The desktop requires a real human GitHub identity; agents use CLI/MCP.',
    );
  login = user.login;
  publicRepo = await client.isPublic();
  let issues: Issue[];
  let nextEtag = '';
  try {
    const response = await client.api.rest.issues.listForRepo({
      ...client.scope,
      labels: 'pronoia',
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      headers: boardEtag ? { 'if-none-match': boardEtag } : undefined,
    });
    nextEtag = response.headers.etag || '';
    issues =
      response.data.length >= 100
        ? await client.issues()
        : z.array(issueSchema).parse(response.data);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 304
    ) {
      return {
        cards: [...cards.values()].map((entry) => entry.card),
        login,
        publicRepo,
      };
    }
    throw error;
  }
  const current = issues.filter((issue) => !issue.pull_request);
  const numbers = new Set(current.map((issue) => issue.number));
  for (const number of cards.keys())
    if (!numbers.has(number)) cards.delete(number);
  for (const issue of current) {
    if (cards.get(issue.number)?.updatedAt === issue.updated_at) continue;
    const comments = await client.comments(issue.number);
    const card = buildCard(issue, comments, config());
    cards.set(issue.number, { updatedAt: issue.updated_at, card });
  }
  boardEtag = nextEtag;
  return {
    cards: [...cards.values()].map((entry) => entry.card),
    login,
    publicRepo,
  };
}

async function itemDetail(number: number) {
  const client = board();
  const issue = await client.issue(number);
  if (issue.pull_request || !issue.labels.includes('pronoia'))
    throw new DesktopError('ITEM', 'Select an existing Pronoia finding.');
  return buildItemDetail(issue, await client.comments(number), config());
}

async function evidencePreview(input: z.infer<typeof evidencePreviewSchema>) {
  const detail = await itemDetail(input.issue);
  const record = detail.evidence.find(
    (entry) => entry.file === input.file && entry.sha256 === input.sha256,
  );
  if (!record)
    throw new DesktopError(
      'EVIDENCE',
      'This evidence is not linked to the selected finding.',
    );
  const bytes = await board().readEvidence(record.file);
  if (
    createHash('sha256').update(bytes).digest('hex') !== record.sha256 ||
    !record.file.endsWith(`-${record.sha256.slice(0, 8)}.png`)
  ) {
    throw new EvidenceError(
      'Published evidence does not match its audited SHA-256.',
    );
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty())
    throw new EvidenceError('Published PNG evidence could not be decoded.');
  return `data:image/png;base64,${image
    .resize({ width: Math.min(480, image.getSize().width) })
    .toPNG()
    .toString('base64')}`;
}

async function sources() {
  return (
    await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 },
    })
  ).map((source) => ({ id: source.id, name: source.name }));
}

function currentSession() {
  if (!session)
    throw new DesktopError(
      'SESSION_REQUIRED',
      'Start a consented session first.',
    );
  return session;
}

function ai() {
  if (!foundry) {
    const configured = foundryConfigSchema.parse({
      endpoint: settings.endpoint,
      deployment: settings.chatDeployment,
      transcribeDeployment: settings.transcribeDeployment || undefined,
      realtimeTranscribeDeployment: settings.realtimeDeployment || undefined,
      auth:
        settings.authMode === 'key'
          ? { mode: 'key', apiKey: settings.apiKey }
          : {
              mode: 'identity',
              clientId: process.env.AZURE_CLIENT_ID || undefined,
            },
    });
    const tokenProvider =
      configured.auth.mode === 'identity'
        ? getBearerTokenProvider(
            new DefaultAzureCredential({
              managedIdentityClientId: configured.auth.clientId,
            }),
            'https://ai.azure.com/.default',
          )
        : undefined;
    foundry = new FoundryService(
      createFoundryClient(configured, { clientClass: OpenAI, tokenProvider }),
      configured,
    );
  }
  return foundry;
}

async function useAi<T>(
  active: Session,
  estimate: number,
  image: boolean,
  request: (signal: AbortSignal) => Promise<AiResult<T>>,
  options: { analysis?: boolean; signal?: AbortSignal } = {},
): Promise<{ value: T; warnings: string[] }> {
  const signal = options.signal ?? active.controller.signal;
  requireCurrentOperation(active.id, session?.id, signal);
  let claim: ReturnType<SessionBudget['claim']> | undefined;
  let settled = false;
  let result: AiResult<T>;
  try {
    claim = active.budget.claim({
      tokens: estimate,
      image,
      analysis: options.analysis,
    });
    await persistSession(active);
    requireCurrentOperation(active.id, session?.id, signal);
    result = await request(signal);
    settled = true;
    const known = claim.complete(result.usage?.total_tokens ?? null);
    if (!known && !active.usageWarning) {
      active.usageWarning = true;
      emit({
        type: 'notice',
        error: {
          code: 'AI_USAGE_ESTIMATE',
          message:
            'This provider did not report token usage; conservative estimates count toward the session budget. This is not an invoice cap.',
        },
      });
    }
    await persistSession(active);
  } catch (error) {
    if (claim && !settled) claim.complete(null);
    if (
      error instanceof DesktopError &&
      error.code === 'AI_TOKEN_BUDGET' &&
      session === active &&
      ['starting', 'active'].includes(active.phase)
    ) {
      active.controller.abort();
      closeRealtime();
      setPhase('paused');
    }
    await persistSession(active);
    throw error;
  }
  for (const warning of result.warnings)
    emit({ type: 'notice', error: { code: 'AI_WARNING', message: warning } });
  if (!result.ok)
    throw new DesktopError(`AI_${result.error.code}`, result.error.message);
  requireCurrentOperation(active.id, session?.id, signal);
  return { value: result.value, warnings: result.warnings };
}

async function modelCall<R extends Role>(
  active: Session,
  role: R,
  input: RoleInput,
  context: RoleContext,
  signal = active.controller.signal,
) {
  // shortcut: reserve two response attempts conservatively; reported usage is not a hard billing cap.
  const estimate =
    2 *
    (Buffer.byteLength(input.text) +
      Buffer.byteLength(JSON.stringify(context)) +
      4096 +
      1600 +
      (input.image_data_url ? 8192 : 0));
  return useAi<RoleOutput<R>>(
    active,
    estimate,
    Boolean(input.image_data_url),
    (caller) => ai().call(role, input, context, caller),
    { signal },
  );
}

async function roleContext(
  active = currentSession(),
  selected?: number,
  signal = active.controller.signal,
): Promise<RoleContext> {
  const client = board();
  if (selected && !active.input.issues.includes(selected))
    throw new DesktopError(
      'ASSESSMENT_SCOPE',
      'The selected finding is outside the consented scope.',
    );
  const numbers = selected ? [selected] : active.input.issues;
  const issues = [];
  const references = new Set<string>();
  for (const number of numbers) {
    requireCurrentOperation(active.id, session?.id, signal);
    const issue = await client.issue(number);
    const comments = await client.comments(number);
    requireCurrentOperation(active.id, session?.id, signal);
    issues.push({ number, state: expectedState(issue, comments, config()) });
    for (const reference of readMeta(issue.body)?.references || [])
      if (allowedExternalUrl(reference)) references.add(reference);
    references.add(issue.html_url);
  }
  return {
    config: config(),
    issues,
    references: [...references].slice(0, 100),
    at: new Date().toISOString(),
  };
}

function reviewedCapture(snapshotId: string, png: string, transcript: string) {
  const capture = captures.get(snapshotId);
  const active = currentSession();
  if (!capture)
    throw new DesktopError('SNAPSHOT', 'This local snapshot is unavailable.');
  requirePublication(publicRepo, true, active.input.synthetic);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png))
    throw new DesktopError('PNG', 'Use a reviewed PNG capture.');
  const bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
  validatePng(bytes);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty())
    throw new DesktopError('PNG', 'The reviewed image could not be decoded.');
  const dimensions = image.getSize();
  const ratio = Math.min(
    1,
    1600 / Math.max(dimensions.width, dimensions.height),
  );
  const reduced =
    ratio < 1
      ? image.resize({
          width: Math.max(1, Math.round(dimensions.width * ratio)),
          height: Math.max(1, Math.round(dimensions.height * ratio)),
        })
      : image;
  const reviewed = {
    ...capture,
    image: png,
    transcript: redactText(transcript),
  };
  captures.set(snapshotId, reviewed);
  return {
    reviewed,
    image: `data:image/png;base64,${reduced.toPNG().toString('base64')}`,
  };
}

async function analyse(input: z.infer<typeof analyseSchema>) {
  const active = currentSession();
  const signal = active.controller.signal;
  if (active.phase !== 'active')
    throw new DesktopError(
      'CAPTURE_PAUSED',
      'Resume the consented session before AI analysis.',
    );
  if (proposals.size >= 20)
    throw new DesktopError(
      'PROPOSAL_LIMIT',
      'Review pending proposals before requesting another analysis.',
    );
  const capture = reviewedCapture(input.snapshot, input.png, input.transcript);
  const context = await roleContext(active, input.issue, signal);
  const response = await modelCall(
    active,
    'Analyst',
    {
      text: JSON.stringify({
        transcript: capture.reviewed.transcript,
        window: capture.reviewed.source,
        items: context.issues.map((issue) => ({
          number: issue.number,
          title: cards.get(issue.number)?.card.title,
          status: issue.state.status,
        })),
      }),
      image_data_url: capture.image,
      image_reviewed: true,
    },
    context,
    signal,
  );
  const output = response.value;
  const queued: QueuedProposal = {
    id: randomUUID(),
    snapshot: input.snapshot,
    image: capture.image,
    proposal: output,
    warnings: response.warnings,
  };
  proposals.set(queued.id, queued);
  proposalCaptures.set(queued.id, capture.reviewed);
  await persistSession(active);
  emit({ type: 'proposal', proposal: queued });
  return queued;
}

async function withAnalysis<T>(operation: () => Promise<T>): Promise<T> {
  if (analysisBusy)
    throw new DesktopError(
      'AI_BUSY',
      'Another screen analysis is in progress.',
    );
  analysisBusy = true;
  try {
    return await operation();
  } finally {
    analysisBusy = false;
  }
}

async function audio(input: z.infer<typeof audioSchema>) {
  const active = currentSession();
  requireCaptureToken(active.capture, input.capture);
  if (input.session !== active.id || active.phase !== 'active')
    throw new DesktopError(
      'CAPTURE_PAUSED',
      'Audio from a stopped or unconsented session was refused.',
    );
  if (
    (input.source === 'You' && !active.input.microphone) ||
    (input.source === 'Meeting' && !active.input.systemAudio)
  ) {
    throw new DesktopError(
      'CAPTURE_SOURCE',
      'This audio source was not consented for the session.',
    );
  }
  if (active.audioPending >= 2)
    throw new DesktopError(
      'AUDIO_BACKPRESSURE',
      'Transcription is behind; pause capture until pending clips finish.',
    );
  active.audioPending += 1;
  const at = input.startedAt ?? new Date().toISOString();
  if (
    input.startedAt &&
    (Date.parse(input.startedAt) < Date.parse(active.startedAt) - 1000 ||
      Date.parse(input.startedAt) > Date.now() + 1000)
  ) {
    active.audioPending -= 1;
    throw new DesktopError(
      'AUDIO_TIMESTAMP',
      'The audio clip timestamp is outside this consented session.',
    );
  }
  try {
    const signal = active.controller.signal;
    const result = await useAi(
      active,
      Math.ceil(input.bytes.byteLength / 128) + 64,
      false,
      (caller) =>
        ai().transcribe(new Uint8Array(input.bytes), undefined, caller),
      { analysis: false },
    );
    const output = result.value;
    const segment: Segment = { at, source: input.source, text: output.text };
    active.segments.push(segment);
    await persistSession(active);
    requireCurrentOperation(active.id, session?.id, signal);
    emit({ type: 'transcript', segment });
  } finally {
    active.audioPending -= 1;
  }
}

async function recordOutcome(
  queued: QueuedProposal,
  outcome: 'accepted' | 'edited' | 'discarded',
  reason: string,
  proposal = queued.proposal,
  action?: ReviewedAction,
) {
  const existing = journal.state.outcomes.find(
    (entry) => entry.id === queued.id,
  );
  let proposalText = '[unpublished local proposal]';
  if (outcome !== 'discarded') {
    if (!action || action.kind !== 'proposal')
      throw new DesktopError(
        'PROPOSAL_LOG',
        'A published decision needs its original reviewed action.',
      );
    proposalText = proposalLog(action).proposal;
  }
  const record: ProposalOutcome = {
    id: queued.id,
    at: existing?.at ?? action?.at ?? new Date().toISOString(),
    repo: action?.repo ?? settings.githubRepo,
    session: action?.session ?? currentSession().id,
    agent: 'Analyst',
    issue: proposal.issue,
    proposal: proposalText,
    proposedCommand: proposal.proposed_command,
    confidence: proposal.confidence,
    outcome,
    reviewer: action?.actor ?? login,
    reason: redactText(reason),
  };
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new DesktopError(
      'OUTCOME_CHANGED',
      'A recorded proposal outcome is immutable; retry the original decision.',
    );
  }
  if (!existing) journal.state.outcomes.push(record);
  await journal.save();
  await appendCsvOnce(
    path.join(settings.exportDir, 'ai-proposals.csv'),
    [
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
    [
      record.at,
      record.session,
      record.agent,
      record.issue,
      record.proposal,
      record.proposedCommand,
      record.confidence,
      record.outcome,
      record.reviewer,
      record.reason,
    ],
  );
}

async function prevalidateHumanCommand(issueNumber: number, body: string) {
  const client = board();
  const issue = await client.issue(issueNumber);
  if (issue.pull_request || !issue.labels.includes('pronoia'))
    throw new DesktopError(
      'ITEM',
      'Commands are limited to existing Pronoia findings.',
    );
  const permission = (
    await client.api.rest.repos.getCollaboratorPermissionLevel({
      ...client.scope,
      username: login,
    })
  ).data.permission;
  if (!['admin', 'write', 'maintain'].includes(permission))
    throw new DesktopError(
      'GITHUB_ROLE',
      'Only an owner, member or collaborator may post assessment commands.',
    );
  const meta = readMeta(issue.body);
  requirePublication(
    publicRepo,
    true,
    meta?.synthetic === true || session?.input.synthetic === true,
  );
  const command = parseCommand(body);
  if (!command)
    throw new DesktopError(
      'COMMAND',
      'Use one permitted command on the first line.',
    );
  if (body.includes('<!-- pronoia:'))
    throw new DesktopError(
      'COMMAND_MARKER',
      'Metadata in observed content cannot authorize a human command.',
    );
  let state = expectedState(
    issue,
    await client.comments(issueNumber),
    config(),
  );
  if (command.name === 'approve')
    state = await client.approvalContext(issue, state);
  nextState(
    state,
    command,
    { login, userType: 'User', association: 'COLLABORATOR' },
    config(),
    new Date().toISOString(),
  );
}

async function actionBase(id: string, synthetic: boolean) {
  await refreshBoard();
  const previous = journal.state.publications.find(
    (entry) => entry.action.id === id,
  )?.action;
  return {
    id,
    repo: settings.githubRepo,
    actor: login,
    session: previous ? previous.session : (session?.id ?? null),
    synthetic: previous ? previous.synthetic : synthetic,
    at: previous?.at ?? new Date().toISOString(),
  };
}

function publicationText(text: string): string {
  return redactText(text).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function copyPublishedFile(filename: string, bytes: Buffer) {
  if (existsSync(filename)) {
    const current = await readFile(filename);
    if (!current.equals(bytes))
      throw new DesktopError(
        'EXPORT_CONFLICT',
        'An exported file already has different content; it was not overwritten.',
      );
    return;
  }
  await atomicWrite(filename, bytes);
}

async function publishRecapFile(filename: string, text: string) {
  const client = board();
  try {
    const previous = z
      .object({
        content: z.string().max(300000),
        encoding: z.literal('base64'),
      })
      .parse(
        (
          await client.api.rest.repos.getContent({
            ...client.scope,
            path: filename,
            ref: 'main',
          })
        ).data,
      );
    if (Buffer.from(previous.content, 'base64').toString('utf8') !== text) {
      throw new DesktopError(
        'RECAP_CHANGED',
        'A recap with this session ID already exists with different content.',
      );
    }
    return;
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ))
      throw error;
  }
  const uploaded = await client.api.rest.repos.createOrUpdateFileContents({
    ...client.scope,
    branch: 'main',
    path: filename,
    message: 'docs: publish human-reviewed session recap [skip ci]',
    content: Buffer.from(text).toString('base64'),
    request: { retries: 0 },
  });
  const content = z
    .object({ content: z.object({ path: z.string() }) })
    .parse(uploaded.data).content;
  if (content.path !== filename)
    throw new DesktopError(
      'RECAP',
      'GitHub did not confirm the expected recap path.',
    );
}

async function runPublication(
  prepare: () => ReviewedAction | Promise<ReviewedAction>,
): Promise<{ url: string }> {
  if (starting)
    throw new DesktopError(
      'SESSION_ACTIVE',
      'Wait for the session to finish starting before publishing.',
    );
  return publicationLock.run(async () => {
    const action = await prepare();
    const existed = journal.state.publications.some(
      (entry) => entry.action.id === action.id,
    );
    let effectStarted = false;
    try {
      await refreshBoard();
      if (
        settings.githubRepo.toLowerCase() !== action.repo.toLowerCase() ||
        login.toLowerCase() !== action.actor.toLowerCase()
      ) {
        throw new DesktopError(
          'PUBLICATION_ACTOR',
          'Retry using the original repository and signed-in human identity.',
        );
      }
      requirePublication(publicRepo, true, action.synthetic);
      if (action.kind === 'recap' && action.session !== session?.id)
        throw new DesktopError(
          'SESSION_CHANGED',
          'This recap belongs to a different session.',
        );
      const commandBody =
        action.kind === 'manual'
          ? action.body
          : action.kind === 'proposal' &&
              action.proposal.proposed_command !== 'none'
            ? `${action.proposal.proposed_command}${['/validate', '/block'].includes(action.proposal.proposed_command) ? ` ${publicationText(action.proposal.reason).replaceAll('\n', ' ')}` : ''}`
            : null;
      const entry = await journal.begin(action, async () => {
        if (
          commandBody &&
          (action.kind === 'manual' || action.kind === 'proposal')
        )
          await prevalidateHumanCommand(action.issue, commandBody);
      });
      if (entry.url) return { url: entry.url };
      if (
        (action.kind === 'evidence' || action.kind === 'proposal') &&
        (action.session !== session?.id ||
          !session.input.issues.includes(action.issue))
      ) {
        throw new DesktopError(
          'ASSESSMENT_SCOPE',
          'The reviewed evidence belongs to a different or expired session scope.',
        );
      }
      let url: string;
      if (action.kind === 'manual') {
        url = await postReviewedComment(
          board(),
          action.issue,
          action.id,
          action.actor,
          `${action.body}\n\nAI-assisted workstation; human-confirmed by @${action.actor}.`,
          async () => {
            await prevalidateHumanCommand(action.issue, action.body);
            effectStarted = true;
          },
        );
        effectStarted = true;
      } else if (action.kind === 'recap') {
        if (!action.session)
          throw new DesktopError(
            'SESSION_REQUIRED',
            'A recap must belong to a consented session.',
          );
        const filename = `sessions/${action.startedAt.slice(0, 10)}-${action.session}.md`;
        const summary = marker('session', {
          session_id: action.session,
          title: session?.input.assessment || 'Assessment session',
          started_at: action.startedAt,
          ended_at: session?.endedAt,
          assessment: session?.input.assessment || '',
          items_touched: action.items,
          recap_file: filename,
        });
        const text = `${summary}\n\n${publicationText(action.text)}`;
        effectStarted = true;
        await publishRecapFile(filename, text);
        url = `https://github.com/${action.repo}/blob/main/${filename}`;
        await copyPublishedFile(
          path.join(settings.exportDir, 'sessions', path.basename(filename)),
          Buffer.from(text),
        );
        for (const number of action.items) {
          await postReviewedComment(
            board(),
            number,
            action.id,
            action.actor,
            `Human-reviewed session recap: ${url}`,
            async () => {
              const issue = await board().issue(number);
              if (!issue.labels.includes('pronoia') || issue.pull_request)
                throw new DesktopError(
                  'ITEM',
                  'A touched finding is no longer available.',
                );
            },
          );
        }
        await appendCsvOnce(
          path.join(settings.exportDir, 'sessions.csv'),
          [
            'session_id',
            'title',
            'started_at',
            'ended_at',
            'assessment',
            'items_touched',
            'recap_file',
          ],
          [
            action.session,
            session?.input.assessment || 'Assessment session',
            action.startedAt,
            session?.endedAt ?? '',
            session?.input.assessment || '',
            action.items.join(';'),
            filename,
          ],
        );
      } else {
        if (!action.session)
          throw new DesktopError(
            'SESSION_REQUIRED',
            'Evidence must belong to a consented session.',
          );
        const image = Buffer.from(
          action.capture.image.slice(action.capture.image.indexOf(',') + 1),
          'base64',
        );
        const file = evidencePath(
          action.issue,
          image,
          action.capture.capturedAt,
        );
        const command =
          action.kind === 'proposal' &&
          action.proposal.proposed_command !== 'none'
            ? `${action.proposal.proposed_command}${['/validate', '/block'].includes(action.proposal.proposed_command) ? ` ${publicationText(action.proposal.reason).replaceAll('\n', ' ')}` : ''}`
            : '';
        const note =
          action.kind === 'proposal'
            ? action.proposal.evidence_note
            : action.note;
        const step = action.kind === 'evidence' ? action.step : '';
        const body = [
          command || 'Reviewed evidence note (no status change).',
          action.kind === 'proposal'
            ? `Result: ${action.proposal.result}\nObserved: ${publicationText(action.proposal.observed)}\nReason: ${publicationText(action.proposal.reason)}`
            : publicationText(note),
          step ? `Remediation step: ${publicationText(step)}` : '',
          `![Reviewed evidence](https://github.com/${action.repo}/blob/evidence/${file}?raw=true)`,
          `Transcript excerpt:\n${publicationText(action.capture.transcript)}`,
          action.kind === 'proposal'
            ? `Remediation:\n${action.proposal.remediation.map((step) => `- ${publicationText(step)}`).join('\n')}`
            : '',
          `AI-assisted, human-confirmed by @${action.actor}.`,
          action.kind === 'proposal' ? proposalMarker(action) : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        url = await postReviewedComment(
          board(),
          action.issue,
          action.id,
          action.actor,
          body,
          async () => {
            if (command) await prevalidateHumanCommand(action.issue, command);
            effectStarted = true;
            await board().addEvidence(action.issue, image, {
              note: publicationText(note),
              source: publicationText(action.capture.source).slice(0, 300),
              session: action.session ?? '',
              step: publicationText(step),
              capturedAt: action.capture.capturedAt,
              reviewed: true,
              synthetic: action.synthetic,
            });
          },
        );
        effectStarted = true;
        await copyPublishedFile(
          path.join(
            settings.exportDir,
            'evidence',
            String(action.issue),
            path.basename(file),
          ),
          image,
        );
        if (action.kind === 'proposal') {
          const queued = proposals.get(action.id);
          if (!queued)
            throw new DesktopError(
              'PROPOSAL',
              'The original proposal cannot be recovered.',
            );
          await recordOutcome(
            queued,
            action.outcome,
            action.proposal.reason,
            action.proposal,
            action,
          );
        }
      }
      if (action.kind !== 'recap' && session?.id === action.session)
        session.touched.add(action.issue);
      await journal.finish(action.id, url);
      if (action.kind === 'proposal') {
        proposals.delete(action.id);
        proposalCaptures.delete(action.id);
      }
      await persistSession();
      boardEtag = '';
      return { url };
    } catch (error) {
      if (!existed && !effectStarted) {
        journal.state.publications = journal.state.publications.filter(
          (entry) => entry.action.id !== action.id,
        );
        await journal.save();
      }
      throw error;
    }
  });
}

async function persistSession(active = session) {
  if (active) {
    const saved = {
      id: active.id,
      startedAt: active.startedAt,
      endedAt: active.endedAt,
      input: active.input,
      sourceName: active.sourceName,
      segments: active.segments,
      touched: [...active.touched],
      budget: active.budget.snapshot,
      recap: active.recap,
    };
    if (session === active) journal.state.session = saved;
    await atomicWrite(
      path.join(store(), 'sessions', `${active.id}.json`),
      JSON.stringify(saved),
    );
  }
  journal.state.proposals = [...proposals.values()].map((queued) => {
    const capture = proposalCaptures.get(queued.id);
    if (!capture)
      throw new DesktopError(
        'RECOVERY_CAPTURE',
        'A pending proposal has no reviewed capture.',
      );
    return { queued, capture };
  });
  await journal.save();
}

function setPhase(phase: z.infer<typeof phaseSchema>) {
  if (session) session.phase = phase;
  emit({ type: 'phase', phase, session: session?.id || null });
}

async function start(input: z.infer<typeof startSchema>) {
  requireConsent(input);
  if (
    starting ||
    publicationLock.busy ||
    recapController ||
    (session && session.phase !== 'stopped')
  )
    throw new DesktopError(
      'SESSION_ACTIVE',
      'Stop the existing session before starting another.',
    );
  if (
    proposals.size ||
    journal.state.publications.some((entry) => entry.url === null)
  )
    throw new DesktopError(
      'PENDING_PROPOSALS',
      'Review/discard pending proposals before starting another session.',
    );
  starting = true;
  const operation = new AbortController();
  startController = operation;
  try {
    await refreshBoard();
    operation.signal.throwIfAborted();
    if (publicRepo && !input.synthetic)
      throw new DesktopError(
        'PUBLIC_DEMO_ONLY',
        'Only synthetic demonstrations may use this public board.',
      );
    const source = (await sources()).find(
      (entry) => entry.id === input.sourceId,
    );
    operation.signal.throwIfAborted();
    if (!source)
      throw new DesktopError(
        'CAPTURE_SOURCE',
        'Select an available meeting window or screen.',
      );
    if (
      (input.microphone || input.systemAudio) &&
      (!settings.endpoint ||
        !settings.chatDeployment ||
        !settings.transcribeDeployment)
    ) {
      throw new DesktopError(
        'FOUNDRY_CONFIG',
        'Configure a Foundry endpoint, vision deployment and transcription deployment before starting.',
      );
    }
    if (process.platform === 'linux' && input.systemAudio)
      throw new DesktopError(
        'SYSTEM_AUDIO',
        'Linux supports microphone capture only.',
      );
    const known = new Set([...cards.keys()]);
    if (input.issues.some((number) => !known.has(number)))
      throw new DesktopError(
        'ASSESSMENT_SCOPE',
        'The selected scope contains an unknown issue.',
      );
    if (
      input.assessment &&
      input.issues.some(
        (number) => cards.get(number)?.card.assessment !== input.assessment,
      )
    ) {
      throw new DesktopError(
        'ASSESSMENT_SCOPE',
        'A selected finding belongs to a different assessment.',
      );
    }
    captures.clear();
    proposalCaptures.clear();
    session = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      phase: 'starting',
      input,
      sourceName: source.name,
      segments: [],
      controller: new AbortController(),
      audioPending: 0,
      budget: new SessionBudget(settings),
      endedAt: null,
      touched: new Set(),
      recap: null,
      usageWarning: false,
      capture: randomUUID(),
    };
    setPhase('starting');
    await persistSession();
    return { session: session.id, platform: process.platform };
  } finally {
    starting = false;
    if (startController === operation) startController = undefined;
  }
}

async function stop() {
  startController?.abort();
  recapController?.abort();
  if (!session) {
    setPhase('idle');
    return;
  }
  session.controller.abort();
  session.capture = randomUUID();
  closeRealtime();
  if (session.watchTimer) clearInterval(session.watchTimer);
  session.endedAt ??= new Date().toISOString();
  setPhase('stopped');
  await persistSession();
}

async function snapshot(): Promise<Snapshot> {
  const active = currentSession();
  const signal = active.controller.signal;
  if (active.phase !== 'active')
    throw new DesktopError(
      'CAPTURE_PAUSED',
      'Capture is disabled until consented recording is active.',
    );
  if (captureBusy)
    throw new DesktopError('CAPTURE_BUSY', 'A capture is already in progress.');
  captureBusy = true;
  try {
    const displays = screen.getAllDisplays();
    const width = Math.max(
      ...displays.map((display) =>
        Math.round(display.size.width * display.scaleFactor),
      ),
    );
    const height = Math.max(
      ...displays.map((display) =>
        Math.round(display.size.height * display.scaleFactor),
      ),
    );
    const source = (
      await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width, height },
      })
    ).find((entry) => entry.id === active.input.sourceId);
    if (!source || source.thumbnail.isEmpty())
      throw new DesktopError(
        'CAPTURE_SOURCE',
        'The selected source is unavailable or protected.',
      );
    const image = source.thumbnail;
    requireCurrentOperation(active.id, session?.id, signal);
    const size = image.getSize();
    const png = image.toPNG();
    validatePng(png);
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    await mkdir(path.join(store(), 'captures'), { recursive: true });
    await writeFile(
      path.join(store(), 'captures', `${active.id}--${id}.png`),
      png,
    );
    requireCurrentOperation(active.id, session?.id, signal);
    const result: Snapshot = {
      id,
      image: `data:image/png;base64,${png.toString('base64')}`,
      capturedAt,
      source: source.name,
      width: size.width,
      height: size.height,
      transcript: active.segments
        .filter((segment) => Date.parse(segment.at) > Date.now() - 180000)
        .map((segment) => `${segment.at} ${segment.source}: ${segment.text}`)
        .join('\n'),
    };
    captures.set(id, result);
    if (captures.size > 24) {
      const oldest = captures.keys().next().value;
      if (oldest && oldest !== id) captures.delete(oldest);
    }
    return result;
  } finally {
    captureBusy = false;
  }
}

async function watch() {
  const active = currentSession();
  const signal = active.controller.signal;
  if (active.phase !== 'active' || captureBusy) return;
  const source = (
    await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 64, height: 36 },
    })
  ).find((entry) => entry.id === active.input.sourceId);
  if (!source || source.thumbnail.isEmpty())
    throw new DesktopError(
      'CAPTURE_SOURCE',
      'The watched source is unavailable or protected.',
    );
  if (signal.aborted || session !== active || active.phase !== 'active') return;
  const image = source.thumbnail.resize({ width: 64, height: 36 });
  const pixels = image.toBitmap();
  const gray = new Uint8Array(64 * 36);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = Math.round(
      ((pixels[i * 4] || 0) +
        (pixels[i * 4 + 1] || 0) +
        (pixels[i * 4 + 2] || 0)) /
        3,
    );
  }
  if (!active.previousFrame || screenChanged(active.previousFrame, gray)) {
    const capture = await snapshot();
    emit({ type: 'snapshot', snapshot: capture });
  }
  active.previousFrame = gray;
}

async function retainPrivateData() {
  const cutoff = Date.now() - config().retention_days * 86400000;
  await prunePrivateFiles(store(), config().retention_days);
  const previous = journal.state.session;
  journal.expire(config().retention_days);
  if (previous && Date.parse(previous.startedAt) < cutoff) {
    journal.state.session = null;
    if (session?.id === previous.id && session.phase === 'stopped')
      session = undefined;
  }
  journal.state.proposals = journal.state.proposals.filter(
    (entry) => Date.parse(entry.capture.capturedAt) >= cutoff,
  );
  for (const [id, capture] of proposalCaptures) {
    if (Date.parse(capture.capturedAt) < cutoff) {
      proposalCaptures.delete(id);
      proposals.delete(id);
    }
  }
  for (const [id, capture] of captures)
    if (Date.parse(capture.capturedAt) < cutoff) captures.delete(id);
  journal.state.publications = journal.state.publications.filter(
    (entry) => Date.parse(entry.action.at) >= cutoff,
  );
  await journal.save();
}

function configureCapturePermissions() {
  if (!window) return;
  const permitted = () =>
    Boolean(session && ['starting', 'active'].includes(session.phase));
  window.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents?.id === window?.webContents.id &&
      details.isMainFrame &&
      details.requestingUrl === window?.webContents.getURL() &&
      permitted() &&
      (permission === 'display-capture' ||
        (permission === 'media' &&
          session?.input.microphone === true &&
          details.mediaType === 'audio')),
  );
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents.id === window?.webContents.id &&
          permitted() &&
          (permission === 'display-capture' ||
            (permission === 'media' &&
              session?.input.microphone === true &&
              'mediaTypes' in details &&
              details.mediaTypes?.length === 1 &&
              details.mediaTypes[0] === 'audio')),
      );
    },
  );
  window.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (
          !permitted() ||
          request.frame?.url !== window?.webContents.getURL() ||
          !session
        ) {
          callback(null);
          return;
        }
        const active = session;
        const signal = active.controller.signal;
        const source = (
          await desktopCapturer.getSources({ types: ['window', 'screen'] })
        ).find((entry) => entry.id === active.input.sourceId);
        requireCurrentOperation(active.id, session?.id, signal);
        if (!source) {
          emit({
            type: 'notice',
            error: {
              code: 'CAPTURE_SOURCE',
              message: 'The selected capture source is no longer available.',
            },
          });
          callback(null);
          return;
        }
        // shortcut: Windows loopback is system-wide; use window-scoped audio when Electron supports it.
        callback(
          process.platform === 'win32' && active.input.systemAudio
            ? { video: source, audio: 'loopback' }
            : { video: source },
        );
      } catch (error) {
        callback(null);
        emit({ type: 'notice', error: errorValue(error) });
      }
    },
    { useSystemPicker: process.platform === 'darwin' },
  );
}

function registerBaseHandlers() {
  const empty = z.object({}).strict();
  register('settings', empty, publicSettings);
  register('save-settings', settingsInputSchema, saveSettings);
  register(
    'export-now',
    z.object({ reviewed: z.literal(true) }).strict(),
    async () => {
      if (starting || recapController)
        throw new DesktopError(
          'SESSION_ACTIVE',
          'Wait for session preparation or recap generation before exporting.',
        );
      return publicationLock.run(async () => {
        await refreshBoard();
        const result = await exportBoard(board(), settings.exportDir);
        return {
          directory: path.join(result.directory, 'latest'),
          generatedAt: result.manifest.generated_at,
          findings: result.manifest.row_counts['findings.csv'],
          evidence: result.manifest.row_counts['evidence.csv'],
          sessions: result.manifest.row_counts['sessions.csv'],
          proposals: result.manifest.row_counts['ai-proposals.csv'],
        };
      });
    },
  );
  register('board', empty, refreshBoard);
  register(
    'item',
    z.object({ issue: z.number().int().positive() }).strict(),
    ({ issue }) => itemDetail(issue),
  );
  register('evidence-preview', evidencePreviewSchema, evidencePreview);
  register('recovery', empty, () => ({
    session: session?.id ?? null,
    phase: session?.phase ?? 'idle',
    proposals: [...proposals.values()],
    recap: session?.recap ?? null,
    pending: journal.state.publications
      .filter((entry) => entry.url === null)
      .map(({ action }) => ({
        id: action.id,
        kind: action.kind,
        actor: action.actor,
        issue: action.kind === 'recap' ? null : action.issue,
        text: pendingReviewText(action),
        image:
          action.kind === 'evidence' || action.kind === 'proposal'
            ? action.capture.image
            : null,
      })),
  }));
  register(
    'retry-publication',
    z.object({ id: z.uuid(), reviewed: z.literal(true) }).strict(),
    ({ id }) => {
      const entry = journal.state.publications.find(
        (entry) => entry.action.id === id,
      );
      if (!entry)
        throw new DesktopError(
          'PUBLICATION',
          'This reviewed publication is unavailable.',
        );
      return runPublication(() => entry.action);
    },
  );
  register('publish-evidence', publishEvidenceSchema, async (input) => {
    const previous = journal.state.publications.find(
      (entry) => entry.action.id === input.id,
    )?.action;
    if (previous) {
      if (
        previous.kind !== 'evidence' ||
        previous.issue !== input.issue ||
        previous.note !== input.note ||
        previous.step !== input.step ||
        previous.capture.image !== input.png ||
        previous.capture.transcript !== redactText(input.transcript)
      ) {
        throw new DesktopError(
          'PUBLICATION_CHANGED',
          'Retry the originally reviewed evidence before editing it.',
        );
      }
      return runPublication(() => previous);
    }
    const active = currentSession();
    if (!active.input.issues.includes(input.issue))
      throw new DesktopError(
        'ASSESSMENT_SCOPE',
        'This finding is outside the consented scope.',
      );
    const { reviewed } = reviewedCapture(
      input.snapshot,
      input.png,
      input.transcript,
    );
    return runPublication(async () => ({
      ...(await actionBase(input.id, active.input.synthetic)),
      kind: 'evidence',
      issue: input.issue,
      capture: reviewed,
      note: input.note,
      step: input.step,
    }));
  });
  register('sources', empty, sources);
  register(
    'copy-notice',
    z.object({ language: z.enum(['en', 'id']) }).strict(),
    ({ language }) => clipboard.writeText(notice[language]),
  );
  register('start', startSchema, start);
  register(
    'media-token',
    z.object({ session: z.string() }).strict(),
    ({ session: id }) => {
      const active = currentSession();
      if (id !== active.id || !['starting', 'active'].includes(active.phase))
        throw new DesktopError(
          'CAPTURE_PAUSED',
          'Audio capture is not consented or has been paused/stopped.',
        );
      return active.capture;
    },
  );
  register(
    'activate',
    z.object({ session: z.string() }).strict(),
    async (input) => {
      const active = currentSession();
      if (active.id !== input.session || active.phase !== 'starting')
        throw new DesktopError(
          'SESSION_STATE',
          'This session cannot be activated.',
        );
      const signal = active.controller.signal;
      setPhase('active');
      if (active.input.provider === 'realtime') {
        reconnects.clear();
        if (active.input.microphone) await realtimeChannel('You');
        if (active.input.systemAudio && active.input.provider === 'realtime')
          await realtimeChannel('Meeting');
      }
      requireCurrentOperation(active.id, session?.id, signal);
      if (session?.phase !== 'active')
        throw new DesktopError(
          'CAPTURE_PAUSED',
          'The session stopped while capture was being activated.',
        );
      if (active.watchTimer) clearInterval(active.watchTimer);
      if (active.input.autoWatch)
        active.watchTimer = setInterval(() => {
          void watch().catch((error: unknown) =>
            emit({ type: 'notice', error: errorValue(error) }),
          );
        }, 20000);
      await persistSession(active);
    },
  );
  register('stop', empty, stop);
  register(
    'pause',
    z.object({ paused: z.boolean() }).strict(),
    async ({ paused }) => {
      const active = currentSession();
      if (!['active', 'paused'].includes(active.phase))
        throw new DesktopError(
          'SESSION_STATE',
          'Only an active session may be paused.',
        );
      if (paused) {
        active.capture = randomUUID();
        active.controller.abort();
        closeRealtime();
      } else {
        active.capture = randomUUID();
        active.controller = new AbortController();
      }
      setPhase(paused ? 'paused' : 'starting');
      await persistSession();
    },
  );
  register('snapshot', empty, snapshot);
  register('audio', audioSchema, audio);
  register('pcm', audioSchema, pcm);
  register('analyse', analyseSchema, (input) =>
    withAnalysis(() => analyse(input)),
  );
  register(
    'ask',
    analyseSchema
      .extend({ question: z.string().trim().min(1).max(4000) })
      .strict(),
    (input) =>
      withAnalysis(async () => {
        const active = currentSession();
        const signal = active.controller.signal;
        if (active.phase !== 'active')
          throw new DesktopError(
            'CAPTURE_PAUSED',
            'Ask AI requires an active consented session.',
          );
        const capture = reviewedCapture(
          input.snapshot,
          input.png,
          input.transcript,
        );
        const response = await modelCall(
          active,
          'Coach',
          {
            text: JSON.stringify({
              question: input.question,
              transcript: capture.reviewed.transcript,
              selected_item: input.issue
                ? {
                    number: input.issue,
                    title: cards.get(input.issue)?.card.title,
                    untrusted_body_excerpt: cards
                      .get(input.issue)
                      ?.card.body.slice(0, 10000),
                  }
                : undefined,
            }),
            image_data_url: capture.image,
            image_reviewed: true,
          },
          await roleContext(active, input.issue, signal),
          signal,
        );
        const output = response.value;
        return `${output.answer}${output.references.length ? `\n\nReferences:\n${output.references.join('\n')}` : ''}`;
      }),
  );
  register('post', postProposalSchema, async (input) => {
    const previous = journal.state.publications.find(
      (entry) => entry.action.id === input.id,
    )?.action;
    if (previous) {
      if (
        previous.kind !== 'proposal' ||
        previous.issue !== input.issue ||
        JSON.stringify(previous.proposal) !== JSON.stringify(input.proposal)
      ) {
        throw new DesktopError(
          'PUBLICATION_CHANGED',
          'Retry the original reviewed proposal before editing it.',
        );
      }
      return runPublication(() => previous);
    }
    const queued = proposals.get(input.id);
    if (!queued)
      throw new DesktopError('PROPOSAL', 'This proposal is no longer pending.');
    const active = currentSession();
    if (!active.input.issues.includes(input.issue))
      throw new DesktopError(
        'ASSESSMENT_SCOPE',
        'The chosen finding is outside this session scope.',
      );
    const capture = proposalCaptures.get(queued.id);
    if (!capture)
      throw new DesktopError(
        'SNAPSHOT',
        'The reviewed capture is unavailable.',
      );
    return runPublication(async () => ({
      ...(await actionBase(input.id, active.input.synthetic)),
      kind: 'proposal',
      publication_version: 2,
      issue: input.issue,
      capture,
      proposal: input.proposal,
      outcome:
        JSON.stringify(input.proposal) === JSON.stringify(queued.proposal)
          ? 'accepted'
          : 'edited',
    }));
  });
  register('recap', empty, async () => {
    const active = currentSession();
    if (active.phase !== 'stopped')
      throw new DesktopError(
        'SESSION_ACTIVE',
        'Stop capture before drafting the session recap.',
      );
    if (active.recap) return { session: active.id, text: active.recap };
    if (recapController)
      throw new DesktopError(
        'AI_BUSY',
        'A recap draft is already in progress.',
      );
    const operation = new AbortController();
    recapController = operation;
    try {
      const response = await modelCall(
        active,
        'Scribe',
        {
          text: JSON.stringify({
            transcript: redactText(
              active.segments
                .map(
                  (segment) =>
                    `${segment.at} ${segment.source}: ${segment.text}`,
                )
                .join('\n'),
            ),
            assessment: active.input.assessment,
            items: [...active.touched],
          }),
        },
        await roleContext(active, undefined, operation.signal),
        operation.signal,
      );
      const output = response.value;
      active.recap = formatRecap(output);
      await persistSession(active);
      return { session: active.id, text: active.recap };
    } finally {
      if (recapController === operation) recapController = undefined;
    }
  });
  register(
    'publish-recap',
    z
      .object({
        session: z.uuid(),
        text: z.string().min(1).max(32000),
        reviewed: z.literal(true),
      })
      .strict(),
    async (input) => {
      const active = currentSession();
      if (input.session !== active.id)
        throw new DesktopError(
          'SESSION_CHANGED',
          'This recap belongs to a different session.',
        );
      if (active.phase !== 'stopped')
        throw new DesktopError(
          'SESSION_ACTIVE',
          'Stop capture before publishing a recap.',
        );
      return runPublication(async () => {
        active.recap = input.text;
        await persistSession(active);
        return {
          ...(await actionBase(active.id, active.input.synthetic)),
          session: active.id,
          kind: 'recap',
          text: input.text,
          startedAt: active.startedAt,
          items: [...active.touched],
        };
      });
    },
  );
  register('manual', manualInputSchema, async ({ id, issue, body }) => {
    return runPublication(async () => {
      const meta = readMeta((await board().issue(issue)).body);
      return {
        ...(await actionBase(
          id,
          meta?.synthetic === true || session?.input.synthetic === true,
        )),
        kind: 'manual',
        issue,
        body,
      };
    });
  });
  register(
    'discard',
    z
      .object({ id: z.string(), reason: z.string().trim().min(1).max(4000) })
      .strict(),
    async ({ id, reason }) => {
      if (publicationLock.busy)
        throw new DesktopError(
          'PUBLICATION_BUSY',
          'Wait for the reviewed publication to finish.',
        );
      if (journal.state.publications.some((entry) => entry.action.id === id))
        throw new DesktopError(
          'PUBLICATION_PENDING',
          'A publication already started for this proposal; retry it instead of discarding it.',
        );
      const queued = proposals.get(id);
      if (!queued)
        throw new DesktopError(
          'PROPOSAL',
          'This proposal is no longer pending.',
        );
      await recordOutcome(queued, 'discarded', reason);
      proposals.delete(id);
      proposalCaptures.delete(id);
      await persistSession();
    },
  );
  register(
    'presenter',
    z.object({ enabled: z.boolean() }).strict(),
    ({ enabled }) => {
      window?.setMinimumSize(900, 600);
      window?.setSize(enabled ? 1600 : 1180, enabled ? 950 : 780);
    },
  );
  register(
    'compact',
    z.object({ enabled: z.boolean() }).strict(),
    ({ enabled }) => {
      window?.setMinimumSize(enabled ? 520 : 900, enabled ? 360 : 600);
      window?.setSize(enabled ? 640 : 1180, enabled ? 480 : 780);
    },
  );
  register(
    'always-on-top',
    z.object({ enabled: z.boolean() }).strict(),
    ({ enabled }) => window?.setAlwaysOnTop(enabled),
  );
  register('open', z.object({ url: z.string() }).strict(), async ({ url }) => {
    if (!allowedExternalUrl(url))
      throw new DesktopError(
        'EXTERNAL_URL',
        'This URL is not an approved HTTPS reference.',
      );
    await shell.openExternal(url);
  });
}

function configureHotkeys() {
  if (!window) return;
  globalShortcut.unregisterAll();
  for (const [key, type] of [
    [settings.hotkeys.evidence, 'request-capture'],
    [settings.hotkeys.ask, 'request-ask'],
    [settings.hotkeys.pause, 'request-pause'],
    [settings.hotkeys.presenter, 'request-presenter'],
  ] as const) {
    if (!globalShortcut.register(key, () => emit({ type }))) {
      emit({
        type: 'notice',
        error: {
          code: 'SHORTCUT',
          message: `${key} is unavailable; use the visible button.`,
        },
      });
    }
  }
}

async function loadReview() {
  journal = await LocalReviewJournal.open(store());
  await retainPrivateData();
  const saved = journal.state.session;
  if (saved) {
    const controller = new AbortController();
    controller.abort();
    session = {
      id: saved.id,
      startedAt: saved.startedAt,
      endedAt: saved.endedAt ?? saved.segments.at(-1)?.at ?? saved.startedAt,
      phase: 'stopped',
      input: saved.input,
      sourceName: saved.sourceName,
      segments: saved.segments,
      touched: new Set(saved.touched),
      budget: new SessionBudget(settings, saved.budget),
      recap: saved.recap,
      audioPending: 0,
      usageWarning: false,
      controller,
      capture: randomUUID(),
    };
  }
  const completed = new Set(journal.state.outcomes.map((entry) => entry.id));
  for (const entry of journal.state.proposals) {
    if (
      completed.has(entry.queued.id) &&
      !journal.state.publications.some(
        (publication) =>
          publication.action.id === entry.queued.id && publication.url === null,
      )
    )
      continue;
    proposals.set(entry.queued.id, entry.queued);
    proposalCaptures.set(entry.queued.id, entry.capture);
    captures.set(entry.capture.id, entry.capture);
  }
}

async function createWindow() {
  window = new BrowserWindow({
    title: 'Pronoia - transparent assessment co-pilot',
    width: 1180,
    height: 780,
    minWidth: 900,
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => {
    void stop().catch((error: unknown) =>
      console.error(errorValue(error).message),
    );
  });
  window.webContents.on(
    'did-start-navigation',
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && session && session.phase !== 'stopped') {
        void stop().catch((error: unknown) =>
          console.error(errorValue(error).message),
        );
      }
    },
  );
  const csp =
    "default-src 'none'; script-src 'self' 'nonce-pronoia-dev'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  window.webContents.session.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    }),
  );
  configureCapturePermissions();
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    await window.loadFile(
      path.join(
        moduleDirectory,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  configureHotkeys();
  window.on('closed', () => {
    window = undefined;
    void stop().catch((error: unknown) =>
      console.error(errorValue(error).message),
    );
  });
}

app
  .whenReady()
  .then(async () => {
    const explicit = process.env.PRONOIA_CONFIG;
    const filename =
      explicit ||
      [
        path.resolve('pronoia.config.yml'),
        path.resolve('..', '..', 'pronoia.config.yml'),
      ].find((candidate) => existsSync(candidate));
    if (filename)
      policy = configSchema.parse(parseYaml(readFileSync(filename, 'utf8')));
    settings = await loadSettings();
    await loadReview();
    registerBaseHandlers();
    await createWindow();
    setInterval(() => {
      void retainPrivateData().catch((error: unknown) =>
        emit({ type: 'notice', error: errorValue(error) }),
      );
    }, 86400000).unref();
  })
  .catch((error: unknown) => {
    const value = errorValue(error);
    console.error(value.message);
    dialog.showErrorBox('Pronoia could not start', value.message);
    app.quit();
  });
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
