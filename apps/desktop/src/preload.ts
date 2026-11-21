import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  cardSchema,
  errorSchema,
  eventSchema,
  exportSummarySchema,
  itemDetailSchema,
  publicSettingsSchema,
  queuedProposalSchema,
  recoverySchema,
  recapResultSchema,
  snapshotSchema,
  type PronoiaApi,
  type Reply,
} from './shared';

async function invoke<T>(
  action: string,
  input: unknown,
  schema: z.ZodType<T>,
): Promise<Reply<T>> {
  const response: unknown = await ipcRenderer.invoke(
    `pronoia:${action}`,
    input,
  );
  const failed = z
    .object({ ok: z.literal(false), error: errorSchema })
    .strict()
    .safeParse(response);
  if (failed.success) return failed.data;
  const success = z
    .object({ ok: z.literal(true), value: z.unknown() })
    .strict()
    .parse(response);
  return { ok: true, value: schema.parse(success.value) };
}

const nothing = z.undefined();
const api: PronoiaApi = {
  settings: () => invoke('settings', {}, publicSettingsSchema),
  exportNow: (input) => invoke('export-now', input, exportSummarySchema),
  saveSettings: (input) => invoke('save-settings', input, publicSettingsSchema),
  board: () =>
    invoke(
      'board',
      {},
      z
        .object({
          cards: z.array(cardSchema),
          login: z.string(),
          publicRepo: z.boolean(),
        })
        .strict(),
    ),
  item: (issue) => invoke('item', { issue }, itemDetailSchema),
  evidencePreview: (input) => invoke('evidence-preview', input, z.string()),
  publishEvidence: (input) =>
    invoke('publish-evidence', input, z.object({ url: z.url() }).strict()),
  recovery: () => invoke('recovery', {}, recoverySchema),
  retryPublication: (input) =>
    invoke('retry-publication', input, z.object({ url: z.url() }).strict()),
  sources: () =>
    invoke(
      'sources',
      {},
      z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    ),
  copyNotice: (language) => invoke('copy-notice', { language }, nothing),
  start: (input) =>
    invoke(
      'start',
      input,
      z.object({ session: z.string(), platform: z.string() }).strict(),
    ),
  activate: (session) => invoke('activate', { session }, nothing),
  mediaToken: (session) => invoke('media-token', { session }, z.uuid()),
  stop: () => invoke('stop', {}, nothing),
  pause: (paused) => invoke('pause', { paused }, nothing),
  audio: (input) => invoke('audio', input, nothing),
  pcm: (input) => invoke('pcm', input, nothing),
  snapshot: () => invoke('snapshot', {}, snapshotSchema),
  analyse: (input) => invoke('analyse', input, queuedProposalSchema),
  ask: (input) => invoke('ask', input, z.string()),
  post: (input) =>
    invoke('post', input, z.object({ url: z.string() }).strict()),
  discard: (input) => invoke('discard', input, nothing),
  manual: (input) =>
    invoke('manual', input, z.object({ url: z.string() }).strict()),
  recap: () => invoke('recap', {}, recapResultSchema),
  publishRecap: (input) =>
    invoke('publish-recap', input, z.object({ url: z.string() }).strict()),
  presenter: (enabled) => invoke('presenter', { enabled }, nothing),
  compact: (enabled) => invoke('compact', { enabled }, nothing),
  alwaysOnTop: (enabled) => invoke('always-on-top', { enabled }, nothing),
  open: (url) => invoke('open', { url }, nothing),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const event = eventSchema.safeParse(payload);
      if (event.success) callback(event.data);
      else
        callback({
          type: 'notice',
          error: {
            code: 'IPC_EVENT',
            message: 'An invalid application event was refused.',
          },
        });
    };
    ipcRenderer.on('pronoia:event', listener);
    return () => ipcRenderer.removeListener('pronoia:event', listener);
  },
};
contextBridge.exposeInMainWorld('pronoia', api);
