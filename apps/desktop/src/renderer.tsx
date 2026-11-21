import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  FluentProvider,
  Input,
  Textarea,
  useRestoreFocusTarget,
  webDarkTheme,
  webLightTheme,
} from '@fluentui/react-components';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Announcements,
} from '@dnd-kit/core';
import { captureAudio } from './capture';
import { redactText } from './safety';
import {
  formatHumanCommand,
  humanCommands,
  retainPending,
  recapForSession,
  reviewedRequest,
  type DisputeType,
  type HumanCommand,
  type HumanDraft,
  type ReviewedRequest,
  type SessionRecap,
} from './renderer-state';
import {
  analyseSchema,
  errorSchema,
  evidencePreviewSchema,
  exportSummarySchema,
  manualInputSchema,
  proposalSchema,
  publishEvidenceSchema,
  recoverySchema,
  settingsInputSchema,
  startSchema,
  type AppEvent,
  type Card,
  type ItemDetail,
  type Proposal,
  type QueuedProposal,
  type Reply,
  type Segment,
  type Settings,
  type Snapshot,
  type Start,
} from './shared';
import './index.css';

const api = window.pronoia;
type Language = 'en' | 'id';
type Phase = Extract<AppEvent, { type: 'phase' }>['phase'];
type CaptureMode = 'evidence' | 'analyse' | 'ask';
const ViewContext = createContext<{
  language: Language;
  contrast: boolean;
  captureControls: ReactNode;
  publicRepo: boolean;
  notice: string;
  dismissNotice: () => void;
}>({
  language: 'en',
  contrast: false,
  captureControls: null,
  publicRepo: true,
  notice: '',
  dismissNotice: () => undefined,
});
function useText() {
  const { language } = useContext(ViewContext);
  return (en: string, id: string) => (language === 'en' ? en : id);
}
const preferencesSchema = z
  .object({
    language: z.enum(['en', 'id']),
    dark: z.boolean(),
    contrast: z.boolean(),
    captionSize: z.number().int().min(16).max(32),
  })
  .strict();
const defaultPreferences = {
  language: 'en' as const,
  dark: false,
  contrast: false,
  captionSize: 18,
};
function savedPreferences(): z.infer<typeof preferencesSchema> {
  try {
    const parsed = preferencesSchema.safeParse(
      JSON.parse(localStorage.getItem('pronoia.preferences') || 'null'),
    );
    return parsed.success ? parsed.data : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}
const initialPreferences = savedPreferences();
const localPngSchema = z
  .string()
  .max(15 * 1024 * 1024)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
const stages: { id: Card['status']; title: string; idTitle: string }[] = [
  { id: 'todo', title: 'To Do', idTitle: 'Belum dikerjakan' },
  { id: 'in-progress', title: 'In Progress', idTitle: 'Dikerjakan' },
  { id: 'validate', title: 'Validate', idTitle: 'Validasi' },
  { id: 'blocked', title: 'Blocked', idTitle: 'Terhambat' },
  { id: 'done', title: 'Done', idTitle: 'Selesai' },
];
const notices = {
  en: 'All participants must be told that audio is transcribed by Microsoft Foundry and screenshots are captured. Raw audio is never stored. Screenshots and transcript excerpts require review/redaction before analysis or publication. AI proposes; humans decide.',
  id: 'Semua peserta harus diberi tahu bahwa audio ditranskripsikan oleh Microsoft Foundry dan layar dapat direkam. Audio mentah tidak disimpan. Gambar dan kutipan transkrip harus ditinjau/disunting sebelum analisis atau publikasi. AI mengusulkan; manusia memutuskan.',
};
function stageLabel(status: string, language: Language) {
  const stage = stages.find((item) => item.id === status);
  return stage ? (language === 'en' ? stage.title : stage.idTitle) : status;
}
function severityLabel(severity: string, language: Language) {
  const labels: Record<string, [string, string]> = {
    critical: ['Critical', 'Kritis'],
    high: ['High', 'Tinggi'],
    medium: ['Medium', 'Sedang'],
    low: ['Low', 'Rendah'],
    info: ['Information', 'Informasi'],
  };
  return labels[severity]?.[language === 'en' ? 0 : 1] || severity;
}
function value<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

function Column({
  stage,
  children,
  count,
  language,
}: {
  stage: (typeof stages)[number];
  children: ReactNode;
  count: number;
  language: 'en' | 'id';
}) {
  const drop = useDroppable({ id: stage.id });
  return (
    <section
      className={`column ${drop.isOver ? 'drop-over' : ''}`}
      ref={drop.setNodeRef}
      aria-label={language === 'en' ? stage.title : stage.idTitle}
    >
      <h3>
        {language === 'en' ? stage.title : stage.idTitle} <Badge>{count}</Badge>
      </h3>
      {children}
    </section>
  );
}

function Finding({
  card,
  pending,
  select,
}: {
  card: Card;
  pending: boolean;
  select: (card: Card) => void;
}) {
  const drag = useDraggable({ id: card.number });
  const restoreFocusTarget = useRestoreFocusTarget();
  const text = useText();
  const { language } = useContext(ViewContext);
  return (
    <article
      ref={drag.setNodeRef}
      className={`finding severity-${card.severity}`}
      style={
        drag.transform
          ? {
              transform: `translate(${drag.transform.x}px,${drag.transform.y}px)`,
            }
          : undefined
      }
    >
      <button
        className="drag-handle"
        aria-label={text(
          `Move finding ${card.number}`,
          `Pindahkan temuan ${card.number}`,
        )}
        title={text(
          'Space to pick up, arrows to move, Escape to cancel.',
          'Spasi untuk memilih, panah untuk memindahkan, Escape untuk membatalkan.',
        )}
        {...drag.listeners}
        {...drag.attributes}
        {...restoreFocusTarget}
      >
        {text('Move', 'Pindahkan')}
      </button>
      <button
        className="finding-title"
        {...restoreFocusTarget}
        data-finding={card.number}
        onClick={() => select(card)}
      >
        #{card.number} {card.title}
      </button>
      <div className="tags">
        <Badge>{severityLabel(card.severity, language)}</Badge>
        <Badge>{card.priority}</Badge>
        {pending && (
          <Badge color="warning">
            {text('Pending workflow', 'Menunggu alur kerja')}
          </Badge>
        )}
      </div>
      <small>{card.assessment}</small>
      <p>
        {text('Owner', 'Penanggung jawab')}:{' '}
        {card.assignees.join(', ') || text('unassigned', 'belum ditugaskan')}
      </p>
    </article>
  );
}

function Modal({
  title,
  close,
  children,
  returnIssue,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  returnIssue?: number;
}) {
  const text = useText();
  const { contrast, captureControls, publicRepo, notice, dismissNotice } =
    useContext(ViewContext);
  const opener = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  // IPC-opened dialogs have no DialogTrigger for Fluent to restore focus to.
  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus();
      else if (returnIssue)
        document
          .querySelector<HTMLButtonElement>(`[data-finding="${returnIssue}"]`)
          ?.focus();
    },
    [],
  );
  return (
    <Dialog
      open
      onOpenChange={(_, data) => {
        if (!data.open) close();
      }}
    >
      <DialogSurface className={`modal ${contrast ? 'high-contrast' : ''}`}>
        <div className="modal-capture-controls">{captureControls}</div>
        <DialogBody className="modal-body">
          <DialogTitle
            action={
              <Button
                onClick={close}
                aria-label={text('Close dialog', 'Tutup dialog')}
              >
                {text('Close', 'Tutup')}
              </Button>
            }
          >
            {title}
          </DialogTitle>
          <DialogContent className="modal-content">
            {publicRepo && (
              <p className="public-warning">
                {text(
                  'Public repository: synthetic demo data only. Published evidence and recaps are public.',
                  'Repositori publik: hanya data demo sintetis. Bukti dan ringkasan yang diterbitkan bersifat publik.',
                )}
              </p>
            )}
            {notice && (
              <div role="alert" className="warning">
                <strong>{notice}</strong>
                <Button onClick={dismissNotice}>
                  {text('Dismiss', 'Tutup pesan')}
                </Button>
              </div>
            )}
            {children}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ExportReview({
  destination,
  repository,
  close,
}: {
  destination: string;
  repository: string;
  close: () => void;
}) {
  const text = useText();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] =
    useState<Reply<z.infer<typeof exportSummarySchema>>>();
  const exporting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const exportNow = async () => {
    if (!reviewed || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      const reply = await api.exportNow({ reviewed: true });
      const checked: Reply<z.infer<typeof exportSummarySchema>> = reply.ok
        ? { ok: true, value: exportSummarySchema.parse(reply.value) }
        : { ok: false, error: errorSchema.parse(reply.error) };
      if (!mounted.current) return;
      setResult(checked);
      if (!checked.ok) setReviewed(false);
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        ok: false,
        error: {
          code:
            error instanceof z.ZodError
              ? 'INVALID_EXPORT_RESPONSE'
              : 'EXPORT_REQUEST_FAILED',
          message:
            error instanceof z.ZodError
              ? text(
                  'The desktop returned an invalid export result.',
                  'Desktop mengembalikan hasil ekspor yang tidak valid.',
                )
              : error instanceof Error
                ? error.message
                : text(
                    'The export request could not be confirmed.',
                    'Permintaan ekspor tidak dapat dikonfirmasi.',
                  ),
        },
      });
      setReviewed(false);
    } finally {
      exporting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={text('Review before export', 'Tinjau sebelum ekspor')}
      close={close}
    >
      <p>
        {text('GitHub board', 'Papan GitHub')}: {repository}
      </p>
      <label>
        {text('Export destination', 'Tujuan ekspor')}
        <Input
          className="export-path"
          aria-label={text('Export destination', 'Tujuan ekspor')}
          readOnly
          value={destination}
        />
      </label>
      <p id="export-warning">
        {text(
          'The published GitHub board, evidence and recaps, and local AI decision log (accepted, edited and discarded, including discard reasons) can contain sensitive text. Check/redact this content before sharing. OneDrive/SharePoint may sync this folder automatically as soon as files are written.',
          'Papan GitHub, bukti dan ringkasan yang diterbitkan, serta log keputusan AI lokal (diterima, disunting dan dibuang, termasuk alasan pembuangan) dapat berisi teks sensitif. Periksa/sunting konten ini sebelum berbagi. OneDrive/SharePoint dapat menyinkronkan folder ini secara otomatis segera setelah berkas ditulis.',
        )}
      </p>
      <p>
        {text(
          'Raw audio, private session files, draft captures and unpublished transcript files are excluded. This exports files only; it does not change GitHub decisions.',
          'Audio mentah, berkas sesi privat, draf tangkapan dan berkas transkrip yang belum diterbitkan tidak disertakan. Ini hanya mengekspor berkas; keputusan GitHub tidak diubah.',
        )}
      </p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {busy && (
          <p>
            {text(
              'Exporting reviewed data to the destination above. Pause and Stop remain available. Closing this dialog does not cancel the file export.',
              'Mengekspor data yang ditinjau ke tujuan di atas. Jeda dan Berhenti tetap tersedia. Menutup dialog ini tidak membatalkan ekspor berkas.',
            )}
          </p>
        )}
        {result?.ok && (
          <>
            <strong>{text('Export complete', 'Ekspor selesai')}</strong>
            <p>
              {text('Generated at', 'Dibuat pada')}: {result.value.generatedAt}
            </p>
            <ul>
              <li>
                {text(
                  `Findings: ${result.value.findings}`,
                  `Temuan: ${result.value.findings}`,
                )}
              </li>
              <li>
                {text(
                  `Evidence: ${result.value.evidence}`,
                  `Bukti: ${result.value.evidence}`,
                )}
              </li>
              <li>
                {text(
                  `Sessions: ${result.value.sessions}`,
                  `Sesi: ${result.value.sessions}`,
                )}
              </li>
              <li>
                {text(
                  `AI decisions: ${result.value.proposals}`,
                  `Keputusan AI: ${result.value.proposals}`,
                )}
              </li>
            </ul>
            <label>
              {text('Export location', 'Lokasi ekspor')}
              <Input
                className="export-path"
                aria-label={text('Export location', 'Lokasi ekspor')}
                readOnly
                value={result.value.directory}
              />
            </label>
          </>
        )}
      </div>
      {result && !result.ok && (
        <div role="alert" className="warning">
          <strong>
            {text('Export failed', 'Ekspor gagal')} ({result.error.code})
          </strong>
          <p>{result.error.message}</p>
          <p>
            {text(
              'No successful export was confirmed. Check connection and destination permissions/free space in Settings, then review and try again. Restart the updated desktop if export is unavailable.',
              'Belum ada ekspor berhasil yang dikonfirmasi. Periksa koneksi serta izin/ruang kosong tujuan di Pengaturan, lalu tinjau dan coba lagi. Mulai ulang desktop yang diperbarui jika ekspor tidak tersedia.',
            )}
          </p>
        </div>
      )}
      {!result?.ok && (
        <Checkbox
          required
          disabled={busy}
          checked={reviewed}
          aria-describedby="export-warning"
          label={text(
            'I reviewed the destination and sensitive text, including discard reasons, and consent to export to this folder (which may sync automatically).',
            'Saya telah meninjau tujuan dan teks sensitif, termasuk alasan pembuangan, dan menyetujui ekspor ke folder ini (yang mungkin disinkronkan otomatis).',
          )}
          onChange={(_, data) => setReviewed(data.checked === true)}
        />
      )}
      <div className="actions">
        <Button onClick={close}>
          {busy || result?.ok
            ? text('Close', 'Tutup')
            : text('Cancel', 'Batal')}
        </Button>
        {!result?.ok && (
          <Button
            appearance="primary"
            disabled={!reviewed || busy}
            onClick={() => void exportNow()}
          >
            {busy
              ? text('Exporting...', 'Mengekspor...')
              : text('Export', 'Ekspor')}
          </Button>
        )}
      </div>
    </Modal>
  );
}

function ReviewCapture({
  snapshot,
  mode,
  cards,
  initialIssue,
  initialStep,
  close,
  finish,
  published,
  report,
}: {
  snapshot: Snapshot;
  mode: CaptureMode;
  cards: Card[];
  initialIssue?: number;
  initialStep?: string;
  close: () => void;
  finish: () => void;
  published: (issue: number, version?: string) => void;
  report: (message: string) => void;
}) {
  const text = useText();
  const canvas = useRef<HTMLCanvasElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const imageGeneration = useRef(0);
  const revision = useRef(0);
  const request = useRef<ReviewedRequest | undefined>(undefined);
  const sending = useRef(false);
  const alive = useRef(true);
  const [transcript, setTranscript] = useState(redactText(snapshot.transcript));
  const [question, setQuestion] = useState('');
  const [issue, setIssue] = useState(
    initialIssue || (mode === 'evidence' ? cards[0]?.number || 0 : 0),
  );
  const [step, setStep] = useState(initialStep || '');
  const [note, setNote] = useState('');
  const [imageReady, setImageReady] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const invalidate = () => {
    revision.current += 1;
    request.current = undefined;
    setReviewed(false);
  };
  const reset = () => {
    invalidate();
    setImageReady(false);
    const source = localPngSchema.safeParse(snapshot.image);
    if (!source.success) {
      report(
        text(
          'The local capture is not a valid PNG.',
          'Tangkapan lokal bukan PNG yang valid.',
        ),
      );
      return;
    }
    const generation = ++imageGeneration.current;
    const image = new Image();
    image.onload = () => {
      const target = canvas.current;
      if (!target || generation !== imageGeneration.current || !alive.current)
        return;
      target.width = image.naturalWidth;
      target.height = image.naturalHeight;
      const context = target.getContext('2d');
      if (!context) {
        report(
          text(
            'The image review canvas is unavailable.',
            'Kanvas tinjauan gambar tidak tersedia.',
          ),
        );
        return;
      }
      context.drawImage(image, 0, 0);
      setImageReady(true);
    };
    image.onerror = () => {
      if (alive.current && generation === imageGeneration.current)
        report(
          text(
            'The local capture could not be displayed.',
            'Tangkapan lokal tidak dapat ditampilkan.',
          ),
        );
    };
    image.src = source.data;
  };
  useEffect(() => {
    alive.current = true;
    reset();
    return () => {
      alive.current = false;
      imageGeneration.current += 1;
    };
  }, [snapshot.id]);
  const coordinates = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = canvas.current;
    if (!target) return { x: 0, y: 0 };
    const rect = target.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * target.width) / rect.width,
      y: ((event.clientY - rect.top) * target.height) / rect.height,
    };
  };
  const send = async () => {
    if (!reviewed || !imageReady || !canvas.current || sending.current) return;
    sending.current = true;
    setBusy(true);
    const version = cards.find((card) => card.number === issue)?.updatedAt;
    try {
      const png = canvas.current.toDataURL('image/png');
      const input = analyseSchema.parse({
        snapshot: snapshot.id,
        png,
        transcript,
        reviewed: true,
        ...(issue ? { issue } : {}),
      });
      if (mode === 'ask') {
        const response = value(
          await api.ask({
            ...input,
            question,
          }),
        );
        if (alive.current) setAnswer(response);
      } else if (mode === 'evidence') {
        request.current = reviewedRequest(
          request.current,
          JSON.stringify({
            snapshot: snapshot.id,
            issue,
            note,
            step,
            revision: revision.current,
          }),
        );
        value(
          await api.publishEvidence(
            publishEvidenceSchema.parse({
              id: request.current.id,
              issue,
              snapshot: snapshot.id,
              png,
              transcript,
              note,
              step,
              reviewed: true,
            }),
          ),
        );
        if (alive.current) {
          published(issue, version);
          finish();
        }
      } else {
        value(await api.analyse(input));
        if (alive.current) finish();
      }
    } catch (error) {
      if (alive.current)
        report(
          error instanceof Error
            ? error.message
            : text(
                'The reviewed request failed. You can retry.',
                'Permintaan yang ditinjau gagal. Anda dapat mencoba lagi.',
              ),
        );
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={
        mode === 'ask'
          ? text(
              'Ask AI - review/redact first',
              'Tanya AI - tinjau/sunting dahulu',
            )
          : mode === 'evidence'
            ? text(
                'Capture evidence - review before publishing',
                'Ambil bukti - tinjau sebelum diterbitkan',
              )
            : text(
                'Review/redact evidence before AI analysis',
                'Tinjau/sunting bukti sebelum analisis AI',
              )
      }
      close={close}
      returnIssue={initialIssue}
    >
      <p>
        {text(
          'Drag opaque rectangles over private content. This image stays local until you explicitly send it.',
          'Seret kotak buram di atas konten privat. Gambar tetap lokal sampai Anda mengirimkannya secara eksplisit.',
        )}
      </p>
      <p>
        {text('Captured', 'Diambil')}:{' '}
        {new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.source}
      </p>
      {mode !== 'evidence' && (
        <label>
          {text('AI context', 'Konteks AI')}
          <select
            value={issue}
            disabled={busy}
            onChange={(event) => {
              setIssue(Number(event.target.value));
              setAnswer('');
              invalidate();
            }}
          >
            <option value={0}>
              {text(
                'All items in session scope',
                'Semua item dalam cakupan sesi',
              )}
            </option>
            {cards.map((card) => (
              <option key={card.number} value={card.number}>
                #{card.number} {card.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <canvas
        ref={canvas}
        className="redaction-canvas"
        aria-label={text(
          'Evidence redaction canvas',
          'Kanvas penyuntingan bukti',
        )}
        aria-describedby="redaction-help"
        onPointerDown={(event) => {
          if (busy || !imageReady) return;
          start.current = coordinates(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          const begin = start.current;
          const end = coordinates(event);
          const context = canvas.current?.getContext('2d');
          if (begin && context) {
            context.fillStyle = '#000';
            context.fillRect(
              Math.min(begin.x, end.x),
              Math.min(begin.y, end.y),
              Math.abs(begin.x - end.x),
              Math.abs(begin.y - end.y),
            );
          }
          start.current = null;
          if (begin) invalidate();
        }}
      />
      <p id="redaction-help">
        {text(
          'Keyboard users can redact the entire image with the button below.',
          'Pengguna papan ketik dapat menyunting seluruh gambar dengan tombol di bawah.',
        )}
      </p>
      <Button onClick={reset} disabled={busy}>
        {text('Reset redactions', 'Atur ulang suntingan')}
      </Button>
      <Button
        disabled={busy || !imageReady}
        onClick={() => {
          const target = canvas.current;
          const context = target?.getContext('2d');
          if (target && context) {
            context.fillStyle = '#000';
            context.fillRect(0, 0, target.width, target.height);
            invalidate();
          }
        }}
      >
        {text(
          'Redact entire image (keyboard alternative)',
          'Sunting seluruh gambar (alternatif papan ketik)',
        )}
      </Button>
      <label>
        {text(
          'Transcript excerpt (editable redaction)',
          'Kutipan transkrip (dapat disunting)',
        )}
        <Textarea
          disabled={busy}
          value={transcript}
          onChange={(_, data) => {
            setTranscript(data.value);
            invalidate();
          }}
          resize="vertical"
        />
      </label>
      {mode === 'evidence' && (
        <>
          <p>
            {text(
              'Save reviewed evidence without calling an AI model.',
              'Simpan bukti yang ditinjau tanpa memanggil model AI.',
            )}
          </p>
          <label>
            {text('Existing finding', 'Temuan yang ada')}
            <select
              value={issue}
              disabled={busy}
              onChange={(event) => {
                setIssue(Number(event.target.value));
                invalidate();
              }}
            >
              <option value={0}>
                {text('Choose a finding', 'Pilih temuan')}
              </option>
              {cards.map((card) => (
                <option key={card.number} value={card.number}>
                  #{card.number} {card.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            {text('Walkthrough step (optional)', 'Langkah panduan (opsional)')}
            <Input
              value={step}
              maxLength={200}
              disabled={busy}
              onChange={(_, data) => {
                setStep(data.value);
                invalidate();
              }}
            />
          </label>
          <label>
            {text('Evidence note', 'Catatan bukti')}
            <Textarea
              value={note}
              maxLength={10000}
              disabled={busy}
              onChange={(_, data) => {
                setNote(data.value);
                invalidate();
              }}
            />
          </label>
        </>
      )}
      {mode === 'ask' && (
        <>
          <div className="actions">
            {(
              [
                [
                  'Explain this CVE',
                  'Jelaskan CVE ini',
                  'Explain this CVE and its remediation using the reviewed evidence.',
                  'Jelaskan CVE ini dan remediasinya menggunakan bukti yang ditinjau.',
                ],
                [
                  'Suggest test steps',
                  'Sarankan langkah pengujian',
                  'Suggest safe test steps for the finding shown in the reviewed evidence.',
                  'Sarankan langkah pengujian yang aman untuk temuan dalam bukti yang ditinjau.',
                ],
                [
                  'Draft evidence note',
                  'Buat draf catatan bukti',
                  'Draft a factual evidence note from this reviewed image and transcript.',
                  'Buat draf catatan bukti faktual dari gambar dan transkrip yang ditinjau ini.',
                ],
              ] as const
            ).map(([en, id, questionEn, questionId]) => (
              <Button
                key={en}
                disabled={busy}
                onClick={() => {
                  setQuestion(text(questionEn, questionId));
                  invalidate();
                }}
              >
                {text(en, id)}
              </Button>
            ))}
          </div>
          <label>
            {text('Question', 'Pertanyaan')}
            <Input
              disabled={busy}
              value={question}
              onChange={(_, data) => {
                setQuestion(data.value);
                invalidate();
              }}
            />
          </label>
        </>
      )}
      <Checkbox
        label={
          mode === 'evidence'
            ? text(
                'I reviewed/redacted the image, excerpt and note and approve publishing them to the configured repository.',
                'Saya meninjau/menyunting gambar, kutipan, dan catatan serta menyetujui penerbitannya ke repositori yang dikonfigurasi.',
              )
            : text(
                'I reviewed the image and excerpt and approve sending this redacted content to Foundry.',
                'Saya meninjau gambar dan kutipan serta menyetujui pengiriman konten yang disunting ke Foundry.',
              )
        }
        disabled={busy}
        checked={reviewed}
        onChange={(_, data) => setReviewed(data.checked === true)}
      />
      <Button
        appearance="primary"
        disabled={
          !reviewed ||
          busy ||
          !imageReady ||
          (mode === 'ask' && !question.trim()) ||
          (mode === 'evidence' && !issue)
        }
        onClick={() => void send()}
      >
        {busy
          ? text('Working...', 'Memproses...')
          : mode === 'ask'
            ? text(
                'Ask with reviewed evidence',
                'Tanya dengan bukti yang ditinjau',
              )
            : mode === 'evidence'
              ? text(
                  'Publish reviewed evidence (no AI)',
                  'Terbitkan bukti yang ditinjau (tanpa AI)',
                )
              : text(
                  'Analyse reviewed evidence',
                  'Analisis bukti yang ditinjau',
                )}
      </Button>
      {answer && <pre className="prose-answer">{answer}</pre>}
    </Modal>
  );
}

function ProposalCard({
  queued,
  cards,
  onPosted,
  onDiscarded,
  onHumanDecision,
  report,
}: {
  queued: QueuedProposal;
  cards: Card[];
  onPosted: (issue: number, version?: string) => void;
  onDiscarded: () => void;
  onHumanDecision: (
    issue: number,
    decision: Proposal['verbal_decision'],
  ) => void;
  report: (message: string) => void;
}) {
  const text = useText();
  const restoreFocusTarget = useRestoreFocusTarget();
  const [edit, setEdit] = useState<Proposal>(queued.proposal);
  const [issue, setIssue] = useState(
    queued.proposal.issue || cards[0]?.number || 0,
  );
  const [reviewed, setReviewed] = useState(false);
  const [discardReason, setDiscardReason] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const posting = useRef(false);
  const image = localPngSchema.safeParse(queued.image);
  const revise = (change: Partial<Proposal>) => {
    setEdit((old) => ({ ...old, ...change }));
    setReviewed(false);
  };
  const post = async () => {
    if (!reviewed || !issue || posting.current) return;
    posting.current = true;
    setBusy(true);
    const version = cards.find((card) => card.number === issue)?.updatedAt;
    try {
      value(
        await api.post({
          id: queued.id,
          issue,
          proposal: proposalSchema.parse({ ...edit, issue }),
          reviewed: true,
        }),
      );
      onPosted(issue, version);
    } catch (error) {
      report(
        error instanceof Error
          ? error.message
          : text('Publication failed.', 'Penerbitan gagal.'),
      );
    } finally {
      posting.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="proposal">
      <h3>
        {text('AI proposal', 'Usulan AI')}{' '}
        <Badge>{Math.round(edit.confidence * 100)}%</Badge>
      </h3>
      {queued.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {image.success ? (
        <img
          src={image.data}
          alt={text(
            'Reviewed and redacted evidence for the proposal',
            'Bukti yang ditinjau dan disunting untuk usulan',
          )}
        />
      ) : (
        <p className="warning">
          {text(
            'The proposal image is unavailable or invalid.',
            'Gambar usulan tidak tersedia atau tidak valid.',
          )}
        </p>
      )}
      <label>
        {text('Existing finding', 'Temuan yang ada')}
        <select
          disabled={busy}
          value={issue}
          onChange={(event) => {
            setIssue(Number(event.target.value));
            setReviewed(false);
          }}
        >
          <option value={0}>{text('Choose a finding', 'Pilih temuan')}</option>
          {cards.map((card) => (
            <option key={card.number} value={card.number}>
              #{card.number} {card.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        {text('Observed', 'Pengamatan')}
        <Textarea
          disabled={busy}
          value={edit.observed}
          onChange={(_, data) => revise({ observed: data.value })}
        />
      </label>
      <label>
        {text('Result', 'Hasil')}
        <select
          disabled={busy}
          value={edit.result}
          onChange={(event) => {
            const result = proposalSchema.shape.result.parse(
              event.target.value,
            );
            revise({ result });
          }}
        >
          <option value="pass">{text('Pass', 'Lulus')}</option>
          <option value="fail">{text('Fail', 'Gagal')}</option>
          <option value="unclear">{text('Unclear', 'Belum jelas')}</option>
          <option value="n/a">{text('Not applicable', 'Tidak berlaku')}</option>
        </select>
      </label>
      <label>
        {text('Proposed command', 'Perintah yang diusulkan')}
        <select
          disabled={busy}
          value={edit.proposed_command}
          onChange={(event) => {
            const command = proposalSchema.shape.proposed_command.parse(
              event.target.value,
            );
            revise({ proposed_command: command });
          }}
        >
          {['none', '/start', '/validate', '/block', '/confirm'].map(
            (command) => (
              <option key={command} value={command}>
                {command === 'none'
                  ? text('No command', 'Tanpa perintah')
                  : command}
              </option>
            ),
          )}
        </select>
      </label>
      <label>
        {text('Reason', 'Alasan')}
        <Textarea
          disabled={busy}
          value={edit.reason}
          onChange={(_, data) => revise({ reason: data.value })}
        />
      </label>
      <label>
        {text(
          'Remediation (maximum seven steps)',
          'Remediasi (maksimal tujuh langkah)',
        )}
        <Textarea
          disabled={busy}
          value={edit.remediation.join('\n')}
          onChange={(_, data) =>
            revise({
              remediation: data.value.split('\n').filter((line) => line.trim()),
            })
          }
        />
      </label>
      <label>
        {text('Evidence note', 'Catatan bukti')}
        <Textarea
          disabled={busy}
          value={edit.evidence_note}
          onChange={(_, data) => revise({ evidence_note: data.value })}
        />
      </label>
      {edit.verbal_decision.type !== 'none' && (
        <div className="warning">
          <p>
            {text('Verbal decision detected', 'Keputusan lisan terdeteksi')}:{' '}
            {edit.verbal_decision.type === 'approve'
              ? text('approval', 'persetujuan')
              : edit.verbal_decision.type === 'reject'
                ? text('rejection', 'penolakan')
                : text('dispute', 'sanggahan')}
          </p>
          <p>
            {edit.verbal_decision.speaker ||
              text(
                'Unidentified speaker',
                'Pembicara tidak teridentifikasi',
              )}{' '}
            · {edit.verbal_decision.at}
          </p>
          <pre className="finding-detail">{edit.verbal_decision.quote}</pre>
          <p>
            {text(
              'This is data, not a board decision. A different human must explicitly submit the validation dialog.',
              'Ini data, bukan keputusan papan. Manusia yang berbeda harus mengirimkan dialog validasi secara eksplisit.',
            )}
          </p>
          <Button
            {...restoreFocusTarget}
            disabled={!issue || busy}
            onClick={() => onHumanDecision(issue, edit.verbal_decision)}
          >
            {text(
              'Review verbal decision as human',
              'Tinjau keputusan lisan sebagai manusia',
            )}
          </Button>
        </div>
      )}
      <Checkbox
        label={text(
          'I reviewed the proposal and approve publishing the reviewed evidence and this command.',
          'Saya meninjau usulan serta menyetujui penerbitan bukti yang ditinjau dan perintah ini.',
        )}
        disabled={busy}
        checked={reviewed}
        onChange={(_, data) => setReviewed(data.checked === true)}
      />
      <div className="actions">
        <Button
          appearance="primary"
          disabled={!reviewed || busy || !issue}
          onClick={() => void post()}
        >
          {text('Confirm & post', 'Konfirmasi & kirim')}
        </Button>
        <Button onClick={() => setDiscardOpen(true)} disabled={busy}>
          {text('Discard', 'Buang')}
        </Button>
      </div>
      {discardOpen && (
        <div>
          <label>
            {text('Discard reason', 'Alasan membuang')}
            <Input
              disabled={busy}
              value={discardReason}
              onChange={(_, data) => setDiscardReason(data.value)}
            />
          </label>
          <Button
            disabled={!discardReason.trim() || busy}
            onClick={() => {
              if (posting.current) return;
              posting.current = true;
              setBusy(true);
              void api
                .discard({ id: queued.id, reason: discardReason })
                .then((reply) => {
                  value(reply);
                  onDiscarded();
                })
                .catch((error: unknown) =>
                  report(
                    error instanceof Error
                      ? error.message
                      : text(
                          'Discard could not be recorded.',
                          'Pembuangan tidak dapat dicatat.',
                        ),
                  ),
                )
                .finally(() => {
                  posting.current = false;
                  setBusy(false);
                });
            }}
          >
            {text('Record discard', 'Catat pembuangan')}
          </Button>
        </div>
      )}
    </section>
  );
}

function EvidencePreview({
  issue,
  evidence,
  report,
}: {
  issue: number;
  evidence: ItemDetail['evidence'][number];
  report: (message: string) => void;
}) {
  const text = useText();
  const [image, setImage] = useState('');
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    let current = true;
    setImage('');
    setFailure(false);
    const input = evidencePreviewSchema.safeParse({
      issue,
      file: evidence.file,
      sha256: evidence.sha256,
    });
    if (!input.success) {
      setFailure(true);
      return;
    }
    void api
      .evidencePreview(input.data)
      .then((reply) => {
        const png = localPngSchema.parse(value(reply));
        if (current) setImage(png);
      })
      .catch((error: unknown) => {
        if (current) {
          setFailure(true);
          report(
            error instanceof Error
              ? error.message
              : text(
                  'Verified preview unavailable.',
                  'Pratinjau terverifikasi tidak tersedia.',
                ),
          );
        }
      });
    return () => {
      current = false;
    };
  }, [issue, evidence.file, evidence.sha256]);
  return (
    <figure className="evidence-preview">
      {image ? (
        <img
          src={image}
          alt={text(
            `Verified evidence for finding ${issue}`,
            `Bukti terverifikasi untuk temuan ${issue}`,
          )}
        />
      ) : (
        <p role="status">
          {failure
            ? text(
                'Preview unavailable; verification did not succeed.',
                'Pratinjau tidak tersedia; verifikasi tidak berhasil.',
              )
            : text('Verifying preview...', 'Memverifikasi pratinjau...')}
        </p>
      )}
      <figcaption>
        <p>
          {text('Captured', 'Diambil')}: {evidence.capturedAt} ·{' '}
          {text('By', 'Oleh')}: {evidence.capturedBy}
        </p>
        <p>
          {text('Source', 'Sumber')}: {evidence.source} ·{' '}
          {text('Session', 'Sesi')}: {evidence.session}
        </p>
        {evidence.step && (
          <p>
            {text('Step', 'Langkah')}: {evidence.step}
          </p>
        )}
        <p>
          SHA-256: <code>{evidence.sha256}</code>
        </p>
        <pre className="finding-detail">{evidence.note}</pre>
        <Button
          onClick={() =>
            void api
              .open(evidence.url)
              .then(value)
              .catch((error: unknown) =>
                report(
                  error instanceof Error
                    ? error.message
                    : text('Reference refused.', 'Referensi ditolak.'),
                ),
              )
          }
        >
          {text('Open evidence reference', 'Buka referensi bukti')}
        </Button>
      </figcaption>
    </figure>
  );
}

const commandLabels: Record<HumanCommand, [string, string]> = {
  '/start': ['Start', 'Mulai'],
  '/validate': ['Request validation', 'Minta validasi'],
  '/approve': ['Approve (four-eyes)', 'Setujui (empat mata)'],
  '/reject': ['Reject', 'Bantah'],
  '/dispute': ['Dispute', 'Sanggah'],
  '/block': ['Block', 'Blokir'],
  '/unblock': ['Unblock', 'Buka blokir'],
  '/reopen': ['Reopen', 'Buka kembali'],
  '/confirm': ['Confirm triage', 'Konfirmasi triase'],
};

function FindingDetail({
  card,
  close,
  command,
  captureStep,
  assist,
  canCapture,
  completed,
  toggleStep,
  report,
}: {
  card: Card;
  close: () => void;
  command: (card: Card, command: HumanCommand) => void;
  captureStep: (issue: number, step: string) => void;
  assist: (mode: 'ask' | 'analyse', issue: number) => void;
  canCapture: boolean;
  completed: Set<string>;
  toggleStep: (key: string) => void;
  report: (message: string) => void;
}) {
  const text = useText();
  const { language } = useContext(ViewContext);
  const [detail, setDetail] = useState<ItemDetail>();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void api
      .item(card.number)
      .then((reply) => {
        if (current) setDetail(value(reply));
      })
      .catch((error: unknown) => {
        if (current)
          report(
            error instanceof Error
              ? error.message
              : text(
                  'Item details unavailable.',
                  'Detail item tidak tersedia.',
                ),
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [card.number, card.updatedAt, retry]);
  const shown = detail?.card || card;
  const evidencePage = Math.min(
    page,
    Math.max(0, Math.ceil((detail?.evidence.length || 0) / 3) - 1),
  );
  return (
    <Modal
      title={`#${card.number} ${card.title}`}
      close={close}
      returnIssue={card.number}
    >
      <p>
        {stageLabel(shown.status, language)} ·{' '}
        {severityLabel(shown.severity, language)} · {shown.priority} ·{' '}
        {text('Owner', 'Penanggung jawab')}:{' '}
        {shown.assignees.join(', ') || text('unassigned', 'belum ditugaskan')}
      </p>
      <p>
        {text(
          'Commands are validated by the shared core through IPC. Only GitHub Actions change the authoritative board.',
          'Perintah divalidasi oleh core bersama melalui IPC. Hanya GitHub Actions yang mengubah papan otoritatif.',
        )}
      </p>
      <div className="actions">
        <Button
          disabled={!canCapture}
          onClick={() => assist('ask', card.number)}
        >
          {text('Ask about this finding', 'Tanya tentang temuan ini')}
        </Button>
        <Button
          disabled={!canCapture}
          onClick={() => assist('analyse', card.number)}
        >
          {text('Analyse this finding', 'Analisis temuan ini')}
        </Button>
        {humanCommands.map((name) => (
          <Button key={name} onClick={() => command(shown, name)}>
            {text(...commandLabels[name])}
          </Button>
        ))}
        <Button
          onClick={() =>
            void api
              .open(shown.url)
              .then(value)
              .catch((error: unknown) =>
                report(
                  error instanceof Error
                    ? error.message
                    : text('Reference refused.', 'Referensi ditolak.'),
                ),
              )
          }
        >
          {text('Open issue reference', 'Buka referensi isu')}
        </Button>
      </div>
      {loading && (
        <p role="status">
          {text('Loading item details...', 'Memuat detail item...')}
        </p>
      )}
      {!detail && !loading && (
        <Button onClick={() => setRetry((old) => old + 1)}>
          {text('Retry loading details', 'Coba muat detail lagi')}
        </Button>
      )}
      {detail && (
        <>
          {detail.warnings.map((warning, index) => (
            <p className="warning" key={index}>
              {warning}
            </p>
          ))}
          <h3>{text('Test', 'Pengujian')}</h3>
          <pre className="finding-detail">
            {detail.test ||
              text('No test documented.', 'Pengujian belum didokumentasikan.')}
          </pre>
          <h3>{text('Procedure', 'Prosedur')}</h3>
          <pre className="finding-detail">
            {detail.procedure ||
              text(
                'No procedure documented.',
                'Prosedur belum didokumentasikan.',
              )}
          </pre>
          <div className="result-comparison">
            <section>
              <h3>{text('Expected result', 'Hasil yang diharapkan')}</h3>
              <pre className="finding-detail">
                {detail.expected || text('Not recorded.', 'Belum dicatat.')}
              </pre>
            </section>
            <section>
              <h3>{text('Actual result', 'Hasil aktual')}</h3>
              <pre className="finding-detail">
                {detail.actual || text('Not recorded.', 'Belum dicatat.')}
              </pre>
            </section>
          </div>
          <h3>{text('Remediation walkthrough', 'Panduan remediasi')}</h3>
          <p>
            {text(
              'Checkmarks are local walkthrough notes, not validation or workflow decisions.',
              'Tanda centang adalah catatan panduan lokal, bukan validasi atau keputusan alur kerja.',
            )}
          </p>
          {!detail.remediation.length && (
            <p>
              {text(
                'No remediation steps recorded.',
                'Langkah remediasi belum dicatat.',
              )}
            </p>
          )}
          {detail.remediation.map((step, index) => {
            const key = `${card.number}:${index}:${step}`;
            return (
              <div className="walkthrough-step" key={key}>
                <Checkbox
                  checked={completed.has(key)}
                  label={`${index + 1}. ${step}`}
                  onChange={() => toggleStep(key)}
                />
                <Button
                  disabled={!canCapture}
                  title={text(
                    'Capture this step, then review/redact before publishing.',
                    'Ambil langkah ini, lalu tinjau/sunting sebelum diterbitkan.',
                  )}
                  onClick={() =>
                    captureStep(
                      card.number,
                      `${index + 1}. ${step}`.slice(0, 200),
                    )
                  }
                >
                  {text(
                    `Capture step ${index + 1}`,
                    `Ambil langkah ${index + 1}`,
                  )}
                </Button>
              </div>
            );
          })}
          <h3>
            {text('Evidence', 'Bukti')} ({detail.evidence.length})
          </h3>
          {!detail.evidence.length && (
            <p>{text('No evidence recorded.', 'Bukti belum dicatat.')}</p>
          )}
          <div className="evidence-gallery">
            {detail.evidence
              .slice(evidencePage * 3, evidencePage * 3 + 3)
              .map((evidence) => (
                <EvidencePreview
                  key={`${evidence.file}:${evidence.sha256}`}
                  issue={card.number}
                  evidence={evidence}
                  report={report}
                />
              ))}
          </div>
          {detail.evidence.length > 3 && (
            <div className="actions">
              <Button
                disabled={evidencePage === 0}
                onClick={() => setPage(evidencePage - 1)}
              >
                {text('Previous evidence', 'Bukti sebelumnya')}
              </Button>
              <span>
                {text('Page', 'Halaman')} {evidencePage + 1} /{' '}
                {Math.ceil(detail.evidence.length / 3)}
              </span>
              <Button
                disabled={(evidencePage + 1) * 3 >= detail.evidence.length}
                onClick={() => setPage(evidencePage + 1)}
              >
                {text('Next evidence', 'Bukti berikutnya')}
              </Button>
            </div>
          )}
          <h3>
            {text('Comments', 'Komentar')} ({detail.comments.length})
          </h3>
          {!detail.comments.length && (
            <p>{text('No comments recorded.', 'Komentar belum dicatat.')}</p>
          )}
          {detail.comments.map((comment) => (
            <article className="item-comment" key={comment.id}>
              <h4>
                {comment.actor} · {comment.at}
              </h4>
              <pre className="finding-detail">{comment.body}</pre>
              <Button
                onClick={() =>
                  void api
                    .open(comment.url)
                    .then(value)
                    .catch((error: unknown) =>
                      report(
                        error instanceof Error
                          ? error.message
                          : text('Reference refused.', 'Referensi ditolak.'),
                      ),
                    )
                }
              >
                {text('Open comment reference', 'Buka referensi komentar')}
              </Button>
            </article>
          ))}
          <div className="table-scroll">
            <table className="validation-trail">
              <caption>{text('Validation trail', 'Jejak validasi')}</caption>
              <thead>
                <tr>
                  {[
                    ['Time', 'Waktu'],
                    ['From', 'Dari'],
                    ['To', 'Ke'],
                    ['Command', 'Perintah'],
                    ['Actor', 'Pelaku'],
                    ['Actor type', 'Jenis pelaku'],
                    ['On behalf of', 'Atas nama'],
                    ['Reason', 'Alasan'],
                    ['Evidence count', 'Jumlah bukti'],
                  ].map(([en, id]) => (
                    <th scope="col" key={en}>
                      {text(en || '', id || '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.trail.map((entry, index) => (
                  <tr key={`${entry.at}:${index}`}>
                    <td>{entry.at}</td>
                    <td>{stageLabel(entry.from, language)}</td>
                    <td>{stageLabel(entry.to, language)}</td>
                    <td>
                      <code>{entry.command}</code>
                    </td>
                    <td>{entry.actor}</td>
                    <td>
                      {entry.actorType === 'human'
                        ? text('Human', 'Manusia')
                        : entry.actorType === 'agent'
                          ? text('Agent', 'Agen')
                          : text('Automation', 'Otomasi')}
                    </td>
                    <td>{entry.onBehalfOf || '—'}</td>
                    <td>{entry.reason}</td>
                    <td>{entry.evidenceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.trail.length && (
              <p>
                {text(
                  'No validation trail recorded.',
                  'Jejak validasi belum dicatat.',
                )}
              </p>
            )}
          </div>
          <details>
            <summary>
              {text(
                'Original issue body (untrusted data)',
                'Isi isu asli (data tidak tepercaya)',
              )}
            </summary>
            <pre className="finding-detail">{shown.body}</pre>
          </details>
        </>
      )}
    </Modal>
  );
}

type PendingPublication = z.infer<typeof recoverySchema>['pending'][number];

function RetryPublication({
  pending,
  close,
  retried,
  report,
}: {
  pending: PendingPublication;
  close: () => void;
  retried: (pending: PendingPublication) => void;
  report: (message: string) => void;
}) {
  const text = useText();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const image = localPngSchema.safeParse(pending.image);
  const canReview = pending.image === null || (image.success && imageReady);
  return (
    <Modal
      title={text(
        'Review recovered publication',
        'Tinjau penerbitan yang dipulihkan',
      )}
      close={close}
      returnIssue={pending.issue || undefined}
    >
      <p>
        {text('Original GitHub actor', 'Pelaku GitHub asli')}:{' '}
        <strong>{pending.actor}</strong> ·{' '}
        {pending.issue
          ? `#${pending.issue}`
          : text('Session recap', 'Ringkasan sesi')}
      </p>
      <p>
        {text(
          'The contents below are immutable and were previously reviewed. Nothing is retried automatically. The same GitHub actor and all server checks are required.',
          'Konten di bawah tidak dapat diubah dan telah ditinjau sebelumnya. Tidak ada percobaan ulang otomatis. Pelaku GitHub yang sama dan seluruh pemeriksaan server tetap diperlukan.',
        )}
      </p>
      <div className={image.success ? 'result-comparison' : undefined}>
        <pre className="finding-detail recovered-publication">
          {pending.text}
        </pre>
        {image.success && (
          <img
            className="recovered-image"
            src={image.data}
            alt={text(
              'Reviewed image for recovered publication',
              'Gambar yang ditinjau untuk penerbitan yang dipulihkan',
            )}
            onLoad={() => setImageReady(true)}
            onError={() => {
              setImageFailed(true);
              setImageReady(false);
              setReviewed(false);
            }}
          />
        )}
      </div>
      {pending.image !== null && (!image.success || imageFailed) && (
        <p className="warning">
          {text(
            'The saved image is invalid. Retry is blocked until a valid reviewed image can be recovered.',
            'Gambar tersimpan tidak valid. Percobaan ulang diblokir sampai gambar yang ditinjau dan valid dapat dipulihkan.',
          )}
        </p>
      )}
      {image.success && !imageReady && !imageFailed && (
        <p role="status">
          {text(
            'Loading the reviewed image...',
            'Memuat gambar yang ditinjau...',
          )}
        </p>
      )}
      <Checkbox
        disabled={busy || !canReview}
        checked={reviewed}
        label={text(
          'I am the original signed-in human, reviewed the complete text, image (if present) and actor above, and approve retrying this exact publication.',
          'Saya adalah manusia asli yang masuk, telah meninjau seluruh teks, gambar (jika ada), dan pelaku di atas, serta menyetujui percobaan ulang penerbitan yang persis sama.',
        )}
        onChange={(_, data) => setReviewed(data.checked === true)}
      />
      <Button
        appearance="primary"
        disabled={!reviewed || busy || !canReview}
        onClick={() => {
          if (!reviewed || !canReview || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          void api
            .retryPublication({ id: pending.id, reviewed: true })
            .then((reply) => {
              value(reply);
              retried(pending);
            })
            .catch((error: unknown) =>
              report(
                error instanceof Error
                  ? error.message
                  : text(
                      'Publication retry failed; the saved action remains pending.',
                      'Percobaan ulang gagal; tindakan tersimpan tetap tertunda.',
                    ),
              ),
            )
            .finally(() => {
              submitting.current = false;
              setBusy(false);
            });
        }}
      >
        {busy
          ? text('Retrying...', 'Mencoba lagi...')
          : text(
              'Retry exact reviewed publication',
              'Coba lagi penerbitan persis yang ditinjau',
            )}
      </Button>
    </Modal>
  );
}

function App() {
  const restoreFocusTarget = useRestoreFocusTarget();
  const [language, setLanguage] = useState<Language>(
    initialPreferences.language,
  );
  const [dark, setDark] = useState(initialPreferences.dark);
  const [contrast, setContrast] = useState(initialPreferences.contrast);
  const [captionSize, setCaptionSize] = useState(
    initialPreferences.captionSize,
  );
  const [presenter, setPresenter] = useState(false);
  const [compact, setCompact] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState<z.infer<typeof settingsInputSchema>>();
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [captureSources, setSources] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [sourceId, setSourceId] = useState('');
  const [assessment, setAssessment] = useState('');
  const [severity, setSeverity] = useState('');
  const [priority, setPriority] = useState('');
  const [scopeIssues, setScopeIssues] = useState<Set<number>>();
  const [login, setLogin] = useState('');
  const [publicRepo, setPublicRepo] = useState(true);
  const [notice, setNotice] = useState('');
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const sessionRef = useRef('');
  const [sessionId, setSessionId] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [captureReady, setCaptureReady] = useState(false);
  const [activeInput, setActiveInput] = useState<Start>();
  const [consented, setConsented] = useState(false);
  const [cloudApproved, setCloud] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [mic, setMic] = useState(true);
  const [systemAudio, setSystem] = useState(true);
  const [provider, setProvider] = useState<'batch' | 'realtime'>('batch');
  const [autoWatch, setWatch] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [queued, setQueued] = useState<QueuedProposal[]>([]);
  const [review, setReview] = useState<{
    snapshot: Snapshot;
    mode: CaptureMode;
    issue?: number;
    step?: string;
  }>();
  const [selected, setSelected] = useState<Card>();
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<{
    issue: number;
    command: HumanCommand;
    destination?: string;
  }>();
  const [reason, setReason] = useState('');
  const [validator, setValidator] = useState('');
  const [disputeType, setDisputeType] = useState<DisputeType>('false-positive');
  const [riskUntil, setRiskUntil] = useState('');
  const [humanReviewed, setHumanReviewed] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const manualRequest = useRef<ReviewedRequest | undefined>(undefined);
  const manualPosting = useRef(false);
  const [pending, setPending] = useState<Map<number, string>>(new Map());
  const [recap, setRecap] = useState<SessionRecap>();
  const [recapOpen, setRecapOpen] = useState(false);
  const [recapReviewed, setRecapReviewed] = useState(false);
  const [recapBusy, setRecapBusy] = useState(false);
  const recapGeneration = useRef(0);
  const [recovered, setRecovered] = useState(false);
  const [recoveredPending, setRecoveredPending] = useState<
    PendingPublication[]
  >([]);
  const [retryPending, setRetryPending] = useState<PendingPublication>();
  const captureController = useRef<AbortController | undefined>(undefined);
  const captureEpoch = useRef(0);
  const operation = useRef(0);
  const operationBusy = useRef(false);
  const snapshotBusy = useRef(false);
  const fallbackRequested = useRef(false);
  const mounted = useRef(true);
  const boardRequest = useRef(0);
  const cardsRef = useRef<Card[]>([]);
  const actions = useRef<
    | {
        capture: (
          mode?: CaptureMode,
          issue?: number,
          step?: string,
        ) => Promise<void>;
        pause: () => Promise<void>;
        presenter: () => Promise<void>;
        fallback: (message: string) => void;
        captureError: (message: string) => void;
        snapshot: (snapshot: Snapshot) => void;
      }
    | undefined
  >(undefined);
  const platform = useRef('');
  const startInput = useRef<Start | undefined>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor),
  );
  const text = (en: string, id: string) => (language === 'en' ? en : id);
  const report = (message: string) => setNotice(message);
  const resetRecap = () => {
    recapGeneration.current += 1;
    setRecap(undefined);
    setRecapOpen(false);
    setRecapReviewed(false);
    setRecapBusy(false);
  };
  const draftRecap = async () => {
    if (recapBusy || phaseRef.current !== 'stopped' || !sessionRef.current)
      return;
    const generation = recapGeneration.current;
    const origin = sessionRef.current;
    setRecapBusy(true);
    try {
      const loaded = value(await api.recap());
      if (
        generation !== recapGeneration.current ||
        origin !== sessionRef.current ||
        phaseRef.current !== 'stopped'
      )
        return;
      const bound = recapForSession(loaded, origin);
      if (!bound) {
        resetRecap();
        report(
          text(
            'This recap belongs to another session. Draft it again.',
            'Ringkasan ini milik sesi lain. Buat drafnya lagi.',
          ),
        );
        return;
      }
      setRecap(bound);
      setRecapReviewed(false);
      setRecapOpen(true);
    } catch (error) {
      if (generation === recapGeneration.current)
        report(
          error instanceof Error
            ? error.message
            : text('Recap draft failed.', 'Draf ringkasan gagal.'),
        );
    } finally {
      if (generation === recapGeneration.current) setRecapBusy(false);
    }
  };
  const publishRecap = async () => {
    const bound = recapForSession(recap, sessionRef.current);
    if (!bound || !recapReviewed || recapBusy || phaseRef.current !== 'stopped')
      return;
    const generation = recapGeneration.current;
    setRecapBusy(true);
    try {
      value(
        await api.publishRecap({
          session: bound.session,
          text: bound.text,
          reviewed: true,
        }),
      );
      if (generation === recapGeneration.current) resetRecap();
    } catch (error) {
      if (generation === recapGeneration.current)
        report(
          error instanceof Error
            ? error.message
            : text('Recap was not published.', 'Ringkasan belum diterbitkan.'),
        );
    } finally {
      if (generation === recapGeneration.current) setRecapBusy(false);
    }
  };
  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };
  const cancelCapture = () => {
    captureEpoch.current += 1;
    captureController.current?.abort();
    captureController.current = undefined;
    setCaptureReady(false);
  };
  const markPending = (
    issue: number,
    version = cardsRef.current.find((card) => card.number === issue)?.updatedAt,
  ) => {
    if (version) setPending((old) => new Map(old).set(issue, version));
  };
  const refresh = async () => {
    const request = ++boardRequest.current;
    try {
      const result = value(await api.board());
      if (!mounted.current || request !== boardRequest.current) return;
      cardsRef.current = result.cards;
      setCards(result.cards);
      setLogin(result.login);
      setPublicRepo(result.publicRepo);
      setPending((old) => retainPending(result.cards, old));
      setSelected((old) =>
        old
          ? result.cards.find((card) => card.number === old.number) || old
          : undefined,
      );
    } catch (error) {
      report(
        error instanceof Error
          ? error.message
          : text(
              'The board could not refresh.',
              'Papan tidak dapat diperbarui.',
            ),
      );
    }
  };
  const capture = async (
    mode: CaptureMode = 'evidence',
    issue?: number,
    step?: string,
  ) => {
    if (
      snapshotBusy.current ||
      phaseRef.current !== 'active' ||
      !captureReady ||
      review ||
      manual ||
      settingsOpen ||
      exportOpen ||
      retryPending ||
      recapOpen
    )
      return;
    snapshotBusy.current = true;
    const epoch = captureEpoch.current;
    try {
      const snapshot = value(await api.snapshot());
      if (
        mounted.current &&
        epoch === captureEpoch.current &&
        phaseRef.current === 'active'
      )
        setReview({
          snapshot,
          mode,
          issue: issue ?? (mode !== 'evidence' ? selected?.number : undefined),
          step,
        });
    } catch (error) {
      report(
        error instanceof Error
          ? error.message
          : text('Capture failed.', 'Pengambilan gagal.'),
      );
    } finally {
      snapshotBusy.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    const recoveryEpoch = captureEpoch.current;
    const recoveryRecapGeneration = recapGeneration.current;
    void api
      .settings()
      .then((reply) => {
        const loaded = value(reply);
        setSettings(loaded);
        setForm(settingsInputSchema.strip().parse(loaded));
      })
      .catch((error: unknown) =>
        report(
          error instanceof Error
            ? error.message
            : text('Settings unavailable.', 'Pengaturan tidak tersedia.'),
        ),
      );
    void api
      .sources()
      .then((reply) => {
        const sources = value(reply);
        setSources(sources);
        setSourceId(sources[0]?.id || '');
      })
      .catch((error: unknown) =>
        report(
          error instanceof Error
            ? error.message
            : text(
                'Capture sources unavailable.',
                'Sumber tangkapan tidak tersedia.',
              ),
        ),
      );
    void api
      .recovery()
      .then((reply) => {
        const restored = recoverySchema.parse(value(reply));
        if (!mounted.current) return;
        setQueued((old) => [
          ...old,
          ...restored.proposals.filter(
            (proposal) => !old.some((item) => item.id === proposal.id),
          ),
        ]);
        setRecoveredPending(restored.pending);
        setRecovered(
          Boolean(
            restored.session ||
            restored.proposals.length ||
            restored.pending.length ||
            restored.recap,
          ),
        );
        if (
          recoveryEpoch === captureEpoch.current &&
          recoveryRecapGeneration === recapGeneration.current &&
          !operationBusy.current
        ) {
          resetRecap();
          sessionRef.current = restored.session || '';
          setSessionId(restored.session || '');
          setPhase(restored.session ? 'stopped' : 'idle');
          if (restored.session && restored.recap !== null)
            setRecap({ session: restored.session, text: restored.recap });
        }
      })
      .catch((error: unknown) =>
        report(
          error instanceof Error
            ? error.message
            : text(
                'Local recovery unavailable.',
                'Pemulihan lokal tidak tersedia.',
              ),
        ),
      );
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      clearInterval(timer);
      mounted.current = false;
      operation.current += 1;
      captureEpoch.current += 1;
      captureController.current?.abort();
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(
        'pronoia.preferences',
        JSON.stringify({ language, dark, contrast, captionSize }),
      );
    } catch {
      report(
        text(
          'Appearance preferences could not be saved locally.',
          'Preferensi tampilan tidak dapat disimpan secara lokal.',
        ),
      );
    }
  }, [language, dark, contrast, captionSize]);
  useEffect(
    () =>
      api.onEvent((event: AppEvent) => {
        if (event.type === 'phase') {
          if (
            ['starting', 'active'].includes(event.phase) &&
            (!captureController.current ||
              captureController.current.signal.aborted)
          )
            return;
          if (
            phaseRef.current === 'starting' &&
            operationBusy.current &&
            !sessionRef.current &&
            event.phase !== 'starting'
          )
            return;
          if (
            event.session &&
            sessionRef.current &&
            event.session !== sessionRef.current
          )
            return;
          setPhase(event.phase);
          if (event.session) {
            sessionRef.current = event.session;
            setSessionId(event.session);
          }
          if (['paused', 'stopped', 'idle'].includes(event.phase))
            cancelCapture();
          if (event.phase === 'stopped') {
            startInput.current = undefined;
            fallbackRequested.current = false;
            setConsented(false);
            setCloud(false);
            setSynthetic(false);
          }
        }
        if (event.type === 'notice') {
          report(event.error.message);
          if (
            [
              'SYSTEM_AUDIO',
              'CAPTURE_SOURCE',
              'AUDIO_BACKPRESSURE',
              'REALTIME_BACKPRESSURE',
            ].includes(event.error.code)
          )
            actions.current?.captureError(event.error.message);
        }
        if (event.type === 'transcript')
          setSegments((old) => {
            const index = event.segment.id
              ? old.findIndex((segment) => segment.id === event.segment.id)
              : -1;
            if (index < 0) return [...old, event.segment];
            return old.map((segment, i) =>
              i === index ? event.segment : segment,
            );
          });
        if (event.type === 'snapshot') {
          actions.current?.snapshot(event.snapshot);
        }
        if (event.type === 'proposal')
          setQueued((old) =>
            old.some((item) => item.id === event.proposal.id)
              ? old
              : [...old, event.proposal],
          );
        if (event.type === 'request-capture') void actions.current?.capture();
        if (event.type === 'request-ask') void actions.current?.capture('ask');
        if (event.type === 'request-presenter')
          void actions.current?.presenter();
        if (event.type === 'request-pause') void actions.current?.pause();
        if (event.type === 'fallback-batch')
          actions.current?.fallback(event.message);
      }),
    [],
  );
  const failCapture = (message: string) => {
    if (
      !startInput.current ||
      !['starting', 'active'].includes(phaseRef.current)
    )
      return;
    const ownedSession = sessionRef.current;
    const starting = phaseRef.current === 'starting';
    const ticket = ++operation.current;
    operationBusy.current = true;
    setSessionBusy(true);
    setStopFailed(false);
    cancelCapture();
    setPhase(starting ? 'stopped' : 'paused');
    report(message);
    void (starting ? api.stop() : api.pause(true))
      .then((reply) => {
        value(reply);
      })
      .catch(async (error: unknown) => {
        if (sessionRef.current !== ownedSession || ticket !== operation.current)
          return;
        setStopFailed(true);
        report(
          `${message} ${text('Backend capture shutdown failed:', 'Penghentian tangkapan backend gagal:')} ${error instanceof Error ? error.message : text('Unknown error.', 'Kesalahan tidak diketahui.')}`,
        );
        if (
          sessionRef.current === ownedSession &&
          phaseRef.current === 'paused'
        ) {
          try {
            value(await api.stop());
            setPhase('stopped');
            setStopFailed(false);
          } catch (stopError) {
            report(
              stopError instanceof Error
                ? stopError.message
                : text(
                    'Stop failed; retry Stop.',
                    'Penghentian gagal; coba Berhenti lagi.',
                  ),
            );
          }
        }
      })
      .finally(() => {
        if (ticket === operation.current) {
          operationBusy.current = false;
          setSessionBusy(false);
        }
      });
  };
  const prepareAudio = async (
    epoch: number,
    input: Start,
    ownedSession: string,
  ): Promise<Start> => {
    let effective = fallbackRequested.current
      ? { ...input, provider: 'batch' as const }
      : input;
    while (true) {
      if (
        !mounted.current ||
        epoch !== captureEpoch.current ||
        sessionRef.current !== ownedSession
      )
        throw new DOMException('Capture cancelled.', 'AbortError');
      const controller = new AbortController();
      captureController.current?.abort();
      captureController.current = controller;
      startInput.current = effective;
      await captureAudio(
        api,
        effective,
        ownedSession,
        platform.current,
        (message) => {
          if (
            epoch === captureEpoch.current &&
            captureController.current === controller &&
            !controller.signal.aborted
          )
            failCapture(message);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (
        !mounted.current ||
        epoch !== captureEpoch.current ||
        sessionRef.current !== ownedSession
      )
        throw new DOMException('Capture cancelled.', 'AbortError');
      if (fallbackRequested.current && effective.provider === 'realtime') {
        controller.abort();
        effective = { ...effective, provider: 'batch' };
        continue;
      }
      fallbackRequested.current = false;
      setActiveInput(effective);
      setCaptureReady(true);
      return effective;
    }
  };
  const fallbackBatch = async () => {
    if (
      operationBusy.current ||
      phaseRef.current !== 'active' ||
      !startInput.current ||
      !sessionRef.current ||
      !platform.current
    )
      return;
    const ownedSession = sessionRef.current;
    const input = { ...startInput.current, provider: 'batch' as const };
    const ticket = ++operation.current;
    operationBusy.current = true;
    setSessionBusy(true);
    cancelCapture();
    const epoch = captureEpoch.current;
    try {
      await prepareAudio(epoch, input, ownedSession);
    } catch (error) {
      if (epoch === captureEpoch.current && sessionRef.current === ownedSession)
        failCapture(
          error instanceof Error
            ? error.message
            : text('Batch fallback failed.', 'Peralihan ke batch gagal.'),
        );
    } finally {
      if (ticket === operation.current) {
        operationBusy.current = false;
        setSessionBusy(false);
      }
    }
  };
  const start = async () => {
    if (
      operationBusy.current ||
      ['starting', 'active', 'paused'].includes(phaseRef.current)
    )
      return;
    const input = startSchema.parse({
      participantsNotified: consented,
      cloudApproved,
      synthetic,
      sourceId,
      assessment,
      issues: cards
        .filter(
          (card) =>
            (!assessment || card.assessment === assessment) &&
            (!scopeIssues || scopeIssues.has(card.number)),
        )
        .slice(0, 100)
        .map((card) => card.number),
      microphone: mic,
      systemAudio,
      provider,
      autoWatch,
    });
    const ticket = ++operation.current;
    operationBusy.current = true;
    setSessionBusy(true);
    setStopFailed(false);
    setActiveInput(undefined);
    resetRecap();
    cancelCapture();
    const epoch = captureEpoch.current;
    captureController.current = new AbortController();
    fallbackRequested.current = false;
    startInput.current = input;
    const previousPhase = phaseRef.current;
    sessionRef.current = '';
    setSessionId('');
    setPhase('starting');
    setSegments([]);
    setNotice('');
    setConsented(false);
    setCloud(false);
    setSynthetic(false);
    let ownedSession: string | undefined;
    try {
      const result = value(await api.start(input));
      ownedSession = result.session;
      if (
        !mounted.current ||
        epoch !== captureEpoch.current ||
        ticket !== operation.current
      )
        return;
      sessionRef.current = result.session;
      setSessionId(result.session);
      platform.current = result.platform;
      setActiveInput(input);
      await prepareAudio(epoch, input, result.session);
      if (epoch !== captureEpoch.current || ticket !== operation.current)
        return;
      value(await api.activate(result.session));
    } catch (error) {
      if (epoch !== captureEpoch.current || ticket !== operation.current)
        return;
      if (ownedSession && sessionRef.current === ownedSession)
        failCapture(
          error instanceof Error
            ? error.message
            : text('Session could not start.', 'Sesi tidak dapat dimulai.'),
        );
      else {
        cancelCapture();
        startInput.current = undefined;
        setPhase(previousPhase);
        report(
          error instanceof Error
            ? error.message
            : text('Session could not start.', 'Sesi tidak dapat dimulai.'),
        );
      }
    } finally {
      if (ticket === operation.current) {
        operationBusy.current = false;
        setSessionBusy(false);
        if (fallbackRequested.current && phaseRef.current === 'active')
          void fallbackBatch();
      }
    }
  };
  const stop = async () => {
    const ticket = ++operation.current;
    operationBusy.current = true;
    setSessionBusy(true);
    setStopFailed(false);
    cancelCapture();
    startInput.current = undefined;
    fallbackRequested.current = false;
    setPhase('stopped');
    setConsented(false);
    setCloud(false);
    setSynthetic(false);
    try {
      value(await api.stop());
    } catch (error) {
      setStopFailed(true);
      report(
        error instanceof Error
          ? error.message
          : text(
              'Session stop failed; retry Stop.',
              'Penghentian sesi gagal; coba Berhenti lagi.',
            ),
      );
    } finally {
      if (ticket === operation.current) {
        operationBusy.current = false;
        setSessionBusy(false);
      }
    }
  };
  const pause = async () => {
    if (
      operationBusy.current ||
      !['active', 'paused'].includes(phaseRef.current) ||
      !startInput.current
    )
      return;
    const paused = phaseRef.current !== 'paused';
    const input = startInput.current;
    const ownedSession = sessionRef.current;
    const ticket = ++operation.current;
    operationBusy.current = true;
    setSessionBusy(true);
    cancelCapture();
    const epoch = captureEpoch.current;
    if (!paused) captureController.current = new AbortController();
    else setPhase('paused');
    try {
      value(await api.pause(paused));
      if (
        !paused &&
        epoch === captureEpoch.current &&
        ticket === operation.current
      ) {
        await prepareAudio(epoch, input, ownedSession);
        if (epoch !== captureEpoch.current || ticket !== operation.current)
          return;
        value(await api.activate(ownedSession));
      }
    } catch (error) {
      if (ticket !== operation.current) return;
      if (!paused)
        failCapture(
          error instanceof Error
            ? error.message
            : text('Resume failed.', 'Melanjutkan gagal.'),
        );
      else {
        report(
          error instanceof Error
            ? error.message
            : text(
                'Pause failed; stopping capture.',
                'Jeda gagal; menghentikan tangkapan.',
              ),
        );
        try {
          value(await api.stop());
          setPhase('stopped');
        } catch (stopError) {
          report(
            stopError instanceof Error
              ? stopError.message
              : text(
                  'Stop failed; retry Stop.',
                  'Penghentian gagal; coba Berhenti lagi.',
                ),
          );
        }
      }
    } finally {
      if (ticket === operation.current) {
        operationBusy.current = false;
        setSessionBusy(false);
        if (fallbackRequested.current && phaseRef.current === 'active')
          void fallbackBatch();
      }
    }
  };
  const changeView = async (kind: 'presenter' | 'compact' | 'alwaysOnTop') => {
    if (viewBusy) return;
    setViewBusy(true);
    try {
      if (kind === 'presenter') {
        value(await api.presenter(!presenter));
        setPresenter(!presenter);
      }
      if (kind === 'compact') {
        value(await api.compact(!compact));
        setCompact(!compact);
      }
      if (kind === 'alwaysOnTop') {
        value(await api.alwaysOnTop(!alwaysOnTop));
        setAlwaysOnTop(!alwaysOnTop);
      }
    } catch (error) {
      report(
        error instanceof Error
          ? error.message
          : text('Window preference failed.', 'Preferensi jendela gagal.'),
      );
    } finally {
      setViewBusy(false);
    }
  };
  const editManual = () => {
    manualRequest.current = undefined;
    setHumanReviewed(false);
  };
  const openManual = (
    card: Card,
    command: HumanCommand,
    note = '',
    destination?: string,
  ) => {
    setSelected(undefined);
    setManual({ issue: card.number, command, destination });
    setReason(note);
    setValidator('');
    setDisputeType('false-positive');
    setRiskUntil('');
    editManual();
  };
  const postManual = async () => {
    if (!manual || !humanReviewed || manualPosting.current) return;
    const needsReason = ['/reject', '/block', '/reopen', '/dispute'].includes(
      manual.command,
    );
    if (needsReason && !reason.trim()) {
      report(text('A reason is required.', 'Alasan wajib diisi.'));
      return;
    }
    manualPosting.current = true;
    setManualBusy(true);
    const version = cardsRef.current.find(
      (card) => card.number === manual.issue,
    )?.updatedAt;
    try {
      const draft: HumanDraft = {
        command: manual.command,
        reason,
        validator,
        disputeType,
        until: riskUntil,
      };
      const body = formatHumanCommand(draft);
      manualRequest.current = reviewedRequest(
        manualRequest.current,
        JSON.stringify({ issue: manual.issue, body }),
      );
      const id = manualRequest.current.id;
      value(
        await api.manual(
          manualInputSchema.parse({
            id,
            issue: manual.issue,
            body,
            reviewed: true,
          }),
        ),
      );
      markPending(manual.issue, version);
      if (manualRequest.current?.id === id) setManual(undefined);
      await refresh();
    } catch (error) {
      report(
        error instanceof Error
          ? error.message
          : text(
              'Command was not published. Retry keeps the same request ID.',
              'Perintah belum diterbitkan. Percobaan ulang mempertahankan ID permintaan yang sama.',
            ),
      );
    } finally {
      manualPosting.current = false;
      setManualBusy(false);
    }
  };
  const drop = (event: DragEndEvent) => {
    const card = cards.find((item) => item.number === Number(event.active.id));
    const destination = String(event.over?.id || '');
    if (!card || card.status === destination) return;
    if (stages.some((stage) => stage.id === destination))
      openManual(card, '/start', '', destination);
  };
  const displayed = cards.filter(
    (card) =>
      (!assessment || card.assessment === assessment) &&
      (!severity || card.severity === severity) &&
      (!priority || card.priority === priority),
  );
  const scopeCandidates = cards.filter(
    (card) => !assessment || card.assessment === assessment,
  );
  const scopeNumbers = scopeCandidates
    .filter((card) => !scopeIssues || scopeIssues.has(card.number))
    .slice(0, 100)
    .map((card) => card.number);
  const active = phase === 'active' && captureReady;
  const currentRecap = recapForSession(recap, sessionId);
  const modalOpen = Boolean(
    review ||
    selected ||
    manual ||
    settingsOpen ||
    exportOpen ||
    retryPending ||
    (recapOpen && currentRecap !== undefined),
  );
  const listening =
    captureReady &&
    ['starting', 'active'].includes(phase) &&
    Boolean(
      activeInput?.microphone ||
      (activeInput?.systemAudio && platform.current !== 'linux'),
    );
  const watching = phase === 'active' && activeInput?.autoWatch === true;
  actions.current = {
    capture,
    pause,
    presenter: () => changeView('presenter'),
    fallback: (message) => {
      report(message);
      if (
        !startInput.current ||
        !['starting', 'active'].includes(phaseRef.current)
      )
        return;
      setProvider('batch');
      fallbackRequested.current = true;
      if (!operationBusy.current) void fallbackBatch();
    },
    captureError: failCapture,
    snapshot: (snapshot) => {
      if (
        phaseRef.current === 'active' &&
        !manual &&
        !settingsOpen &&
        !exportOpen &&
        !retryPending &&
        !recapOpen
      )
        setReview(
          (old) =>
            old || { snapshot, mode: 'analyse', issue: selected?.number },
        );
    },
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      text(`Picked up finding ${active.id}.`, `Temuan ${active.id} dipilih.`),
    onDragOver: ({ active, over }) =>
      over
        ? text(
            `Finding ${active.id} over ${stageLabel(String(over.id), language)}.`,
            `Temuan ${active.id} di atas ${stageLabel(String(over.id), language)}.`,
          )
        : text('No destination selected.', 'Tujuan belum dipilih.'),
    onDragEnd: ({ active, over }) =>
      over
        ? text(
            `Review a human command for finding ${active.id}; the board has not changed.`,
            `Tinjau perintah manusia untuk temuan ${active.id}; papan belum berubah.`,
          )
        : text('Move cancelled.', 'Pemindahan dibatalkan.'),
    onDragCancel: () => text('Move cancelled.', 'Pemindahan dibatalkan.'),
  };
  const captureControls = (
    <div
      className="capture-controls"
      role="group"
      aria-label={text(
        'Capture status and safety controls',
        'Status tangkapan dan kontrol keselamatan',
      )}
    >
      {listening && (
        <span className="capture-badge live">
          {text('Listening', 'Mendengarkan')}
        </span>
      )}
      {watching && (
        <span className="capture-badge live">
          {text('Watching', 'Mengamati')}
        </span>
      )}
      {stopFailed && (
        <span className="capture-badge live">
          {text(
            'Capture shutdown unconfirmed — retry Stop',
            'Penghentian tangkapan belum terkonfirmasi — coba Berhenti lagi',
          )}
        </span>
      )}
      {!listening && !watching && !stopFailed && (
        <span className="capture-badge">
          {phase === 'paused'
            ? text('Private / Paused', 'Privat / Dijeda')
            : phase === 'starting'
              ? text(
                  'Starting — not listening yet',
                  'Memulai — belum mendengarkan',
                )
              : active
                ? text(
                    'Screen capture ready (manual)',
                    'Tangkapan layar siap (manual)',
                  )
                : text('Not capturing', 'Tidak merekam')}
        </span>
      )}
      <Button
        disabled={sessionBusy || !['active', 'paused'].includes(phase)}
        onClick={() => void pause()}
        title={settings?.hotkeys.pause}
      >
        {phase === 'paused'
          ? text('Resume', 'Lanjutkan')
          : text('Pause / Private', 'Jeda / Privat')}
      </Button>
      <Button
        disabled={
          !stopFailed &&
          !sessionBusy &&
          !['starting', 'active', 'paused'].includes(phase)
        }
        onClick={() => void stop()}
      >
        {text('Stop', 'Berhenti')}
      </Button>
    </div>
  );
  const closeSettings = () => {
    if (settings) setForm(settingsInputSchema.strip().parse(settings));
    setSettingsOpen(false);
  };
  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <ViewContext.Provider
        value={{
          language,
          contrast,
          captureControls,
          publicRepo,
          notice,
          dismissNotice: () => setNotice(''),
        }}
      >
        <div
          className={`${contrast ? 'high-contrast' : ''} ${presenter ? 'presenter' : 'operator'} ${compact ? 'compact' : ''} app`}
        >
          <header className="toolbar">
            <h1>Pronoia</h1>
            {captureControls}
            <Button
              disabled={viewBusy}
              aria-pressed={presenter}
              onClick={() => void changeView('presenter')}
              title={settings?.hotkeys.presenter}
            >
              {text('Presenter view', 'Tampilan presenter')}
            </Button>
            <Button
              disabled={viewBusy}
              aria-pressed={compact}
              onClick={() => void changeView('compact')}
            >
              {text('Compact operator view', 'Tampilan operator ringkas')}
            </Button>
            <Checkbox
              disabled={viewBusy}
              checked={alwaysOnTop}
              label={text('Always on top', 'Selalu di atas')}
              onChange={() => void changeView('alwaysOnTop')}
            />
            <Button
              {...restoreFocusTarget}
              disabled={!settings || settingsBusy || snapshotBusy.current}
              onClick={() => {
                if (!snapshotBusy.current) setExportOpen(true);
              }}
            >
              {text('Export now', 'Ekspor sekarang')}
            </Button>
            <Button
              {...restoreFocusTarget}
              onClick={() => setSettingsOpen(true)}
            >
              {text('Settings', 'Pengaturan')}
            </Button>
            <select
              aria-label={text('UI language', 'Bahasa antarmuka')}
              value={language}
              onChange={(event) =>
                setLanguage(event.target.value === 'id' ? 'id' : 'en')
              }
            >
              <option value="en">{text('English', 'Bahasa Inggris')}</option>
              <option value="id">Bahasa Indonesia</option>
            </select>
          </header>
          {notice && !modalOpen && (
            <div role="alert" className="warning">
              <strong>{notice}</strong>
              <Button onClick={() => setNotice('')}>
                {text('Dismiss', 'Tutup pesan')}
              </Button>
            </div>
          )}
          {publicRepo && (
            <p className="public-warning">
              {text(
                'Public demo only: capture and publish synthetic data only. Real engagements require an approved private repository and Foundry region.',
                'Hanya demo publik: ambil dan terbitkan data sintetis saja. Pekerjaan nyata memerlukan repositori privat dan region Foundry yang disetujui.',
              )}
            </p>
          )}
          {recovered && (
            <section
              className="recovery-notice"
              aria-label={text('Local recovery', 'Pemulihan lokal')}
            >
              <p>
                {text(
                  'Recovered stopped session and pending reviews. Capture has not restarted; nothing is published automatically.',
                  'Sesi yang berhenti dan tinjauan tertunda dipulihkan. Tangkapan tidak dimulai lagi; tidak ada penerbitan otomatis.',
                )}
              </p>
              {currentRecap !== undefined && (
                <Button
                  {...restoreFocusTarget}
                  onClick={() => setRecapOpen(true)}
                >
                  {text(
                    'Review recovered recap',
                    'Tinjau ringkasan yang dipulihkan',
                  )}
                </Button>
              )}
            </section>
          )}
          {activeInput && ['starting', 'active', 'paused'].includes(phase) && (
            <p className="active-scope">
              <strong>
                {text('Active session scope', 'Cakupan sesi aktif')}:
              </strong>{' '}
              {activeInput.assessment ||
                text('All assessments', 'Semua asesmen')}{' '}
              · {activeInput.issues.length} {text('items', 'item')} ·{' '}
              {text('Source', 'Sumber')}:{' '}
              {captureSources.find(
                (source) => source.id === activeInput.sourceId,
              )?.name || activeInput.sourceId}
              {' · '}
              {text('Microphone', 'Mikrofon')}:{' '}
              {activeInput.microphone
                ? text('on', 'aktif')
                : text('off', 'nonaktif')}
              {' · '}
              {text('System audio', 'Audio sistem')}:{' '}
              {activeInput.systemAudio && platform.current !== 'linux'
                ? text('on', 'aktif')
                : text('off / unavailable', 'nonaktif / tidak tersedia')}
              {' · '}
              {text(
                'Automatic screen watch',
                'Pengamatan layar otomatis',
              )}:{' '}
              {activeInput.autoWatch
                ? text('on', 'aktif')
                : text('off', 'nonaktif')}
              {' · '}
              <code>{sessionId}</code>
            </p>
          )}
          <div className="filters">
            <label>
              {text('Assessment', 'Asesmen')}
              <select
                value={assessment}
                onChange={(event) => {
                  setAssessment(event.target.value);
                  setScopeIssues(undefined);
                }}
              >
                <option value="">
                  {text('All assessments', 'Semua asesmen')}
                </option>
                {[...new Set(cards.map((card) => card.assessment))].map(
                  (name) => (
                    <option key={name}>{name}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              {text('Severity', 'Keparahan')}
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
              >
                <option value="">
                  {text('All severities', 'Semua keparahan')}
                </option>
                {['critical', 'high', 'medium', 'low', 'info'].map((value) => (
                  <option key={value} value={value}>
                    {severityLabel(value, language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {text('Priority', 'Prioritas')}
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              >
                <option value="">
                  {text('All priorities', 'Semua prioritas')}
                </option>
                {['p1', 'p2', 'p3', 'p4'].map((value) => (
                  <option key={value} value={value}>
                    {value.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {text('Caption size', 'Ukuran takarir')}
              <input
                type="range"
                min={16}
                max={32}
                value={captionSize}
                onChange={(event) => setCaptionSize(Number(event.target.value))}
              />
            </label>
            <Checkbox
              label={text('Dark', 'Gelap')}
              checked={dark}
              onChange={(_, data) => setDark(data.checked === true)}
            />
            <Checkbox
              label={text('High contrast', 'Kontras tinggi')}
              checked={contrast}
              onChange={(_, data) => setContrast(data.checked === true)}
            />
            <span>
              {login
                ? `@${login}`
                : text('GitHub not connected', 'GitHub belum terhubung')}{' '}
              {publicRepo && (
                <Badge color="warning">
                  {text('Public demo only', 'Hanya demo publik')}
                </Badge>
              )}
            </span>
          </div>
          {!['active', 'paused', 'starting'].includes(phase) && (
            <section className="consent">
              <h2>{text('Session consent', 'Persetujuan sesi')}</h2>
              <p>{notices[language]}</p>
              <Button
                onClick={() =>
                  void api
                    .copyNotice(language)
                    .then((reply) => value(reply))
                    .catch((error: unknown) =>
                      report(
                        error instanceof Error
                          ? error.message
                          : text(
                              'Notice copy failed.',
                              'Penyalinan pemberitahuan gagal.',
                            ),
                      ),
                    )
                }
              >
                {text(
                  'Copy meeting-chat notice',
                  'Salin pemberitahuan obrolan rapat',
                )}
              </Button>
              <Checkbox
                label={text(
                  'All participants were told this session is transcribed and screenshots are captured.',
                  'Semua peserta sudah diberi tahu bahwa sesi ditranskripsikan dan layar dapat diambil.',
                )}
                checked={consented}
                onChange={(_, data) => setConsented(data.checked === true)}
              />
              <Checkbox
                label={text(
                  'Participants approved cloud processing in the configured Foundry region.',
                  'Peserta menyetujui pemrosesan cloud di region Foundry yang dikonfigurasi.',
                )}
                checked={cloudApproved}
                onChange={(_, data) => setCloud(data.checked === true)}
              />
              {publicRepo && (
                <Checkbox
                  label={text(
                    'Only synthetic demo data will be captured/published in this public repository.',
                    'Hanya data demo sintetis yang akan diambil/diterbitkan di repositori publik ini.',
                  )}
                  checked={synthetic}
                  onChange={(_, data) => setSynthetic(data.checked === true)}
                />
              )}
              <details className="scope-selector">
                <summary>
                  {text('Items in session scope', 'Item dalam cakupan sesi')} (
                  {scopeNumbers.length})
                </summary>
                <fieldset>
                  <legend>
                    {text(
                      'Choose assessment items for the next session',
                      'Pilih item asesmen untuk sesi berikutnya',
                    )}
                  </legend>
                  <div className="actions">
                    <Button onClick={() => setScopeIssues(undefined)}>
                      {text(
                        'Select all (up to 100)',
                        'Pilih semua (maksimal 100)',
                      )}
                    </Button>
                    <Button onClick={() => setScopeIssues(new Set())}>
                      {text('Clear item selection', 'Hapus pilihan item')}
                    </Button>
                  </div>
                  {scopeCandidates.length > 100 && (
                    <p>
                      {text(
                        'A session can contain up to 100 items. Only the selected first 100 are included.',
                        'Sesi dapat memuat maksimal 100 item. Hanya 100 item terpilih pertama yang disertakan.',
                      )}
                    </p>
                  )}
                  {!scopeCandidates.length && (
                    <p>
                      {text(
                        'No assessment items loaded.',
                        'Item asesmen belum dimuat.',
                      )}
                    </p>
                  )}
                  {scopeCandidates.map((card) => (
                    <Checkbox
                      key={card.number}
                      checked={scopeNumbers.includes(card.number)}
                      label={`#${card.number} ${card.title}`}
                      onChange={(_, data) => {
                        const next = new Set(scopeNumbers);
                        if (data.checked === true && next.size < 100)
                          next.add(card.number);
                        else next.delete(card.number);
                        setScopeIssues(next);
                      }}
                    />
                  ))}
                </fieldset>
              </details>
              <div className="actions">
                <label>
                  {text('Capture source', 'Sumber tangkapan')}
                  <select
                    value={sourceId}
                    onChange={(event) => setSourceId(event.target.value)}
                  >
                    {captureSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Checkbox
                  label={text('Microphone (You)', 'Mikrofon (Anda)')}
                  checked={mic}
                  onChange={(_, data) => setMic(data.checked === true)}
                />
                <Checkbox
                  label={text(
                    'System audio (Meeting; Windows is system-wide)',
                    'Audio sistem (Rapat; Windows mencakup seluruh sistem)',
                  )}
                  checked={systemAudio}
                  onChange={(_, data) => setSystem(data.checked === true)}
                />
                <select
                  aria-label={text(
                    'Transcription provider',
                    'Penyedia transkripsi',
                  )}
                  value={provider}
                  onChange={(event) =>
                    setProvider(
                      event.target.value === 'realtime' ? 'realtime' : 'batch',
                    )
                  }
                >
                  <option value="batch">
                    {text(
                      'Batch - 15-second complete clips',
                      'Batch - klip lengkap 15 detik',
                    )}
                  </option>
                  <option value="realtime">
                    {text('Realtime - PCM 24 kHz', 'Waktu nyata - PCM 24 kHz')}
                  </option>
                </select>
                <Checkbox
                  label={text(
                    'Watch for meaningful screen changes (review required)',
                    'Amati perubahan layar bermakna (wajib ditinjau)',
                  )}
                  checked={autoWatch}
                  onChange={(_, data) => setWatch(data.checked === true)}
                />
                <Button
                  appearance="primary"
                  disabled={
                    !consented ||
                    !cloudApproved ||
                    (publicRepo && !synthetic) ||
                    !sourceId ||
                    sessionBusy ||
                    stopFailed
                  }
                  onClick={() => void start()}
                >
                  {sessionBusy
                    ? text('Starting...', 'Memulai...')
                    : text(
                        'Start consented session',
                        'Mulai sesi yang disetujui',
                      )}
                </Button>
              </div>
            </section>
          )}
          <div className="workspace">
            <aside className="transcript">
              <h2>{text('Live transcript', 'Transkrip langsung')}</h2>
              <div
                aria-live="polite"
                className="captions"
                style={{ fontSize: captionSize }}
              >
                {segments.map((segment, index) => (
                  <p key={`${segment.at}-${index}`}>
                    <small>
                      {new Date(segment.at).toLocaleTimeString()}{' '}
                      {segment.source === 'You'
                        ? text('You', 'Anda')
                        : text('Meeting', 'Rapat')}
                    </small>
                    <br />
                    {segment.text}
                  </p>
                ))}
                {!segments.length && (
                  <p>
                    {text(
                      'Consented audio appears after one complete chunk plus model latency.',
                      'Audio yang disetujui muncul setelah satu klip lengkap dan waktu pemrosesan model.',
                    )}
                  </p>
                )}
              </div>
              <Button
                {...restoreFocusTarget}
                disabled={phase !== 'stopped' || recapBusy || !sessionId}
                onClick={() => void draftRecap()}
              >
                {text('Draft session recap', 'Buat draf ringkasan sesi')}
              </Button>
              {currentRecap !== undefined && (
                <Button
                  {...restoreFocusTarget}
                  onClick={() => setRecapOpen(true)}
                >
                  {text('Review saved recap', 'Tinjau ringkasan tersimpan')}
                </Button>
              )}
            </aside>
            <main>
              <div className="board-heading">
                <h2>
                  {text('Assessment board', 'Papan asesmen')}{' '}
                  <Badge>{displayed.length}</Badge>
                </h2>
                <Badge>
                  {text(
                    'WIP (In Progress + Validate)',
                    'WIP (Dikerjakan + Validasi',
                  )}
                  :{' '}
                  {
                    displayed.filter((card) =>
                      ['in-progress', 'validate'].includes(card.status),
                    ).length
                  }
                </Badge>
                <Button
                  {...restoreFocusTarget}
                  disabled={!active}
                  onClick={() => void capture()}
                >
                  {text('Capture evidence', 'Ambil bukti')}
                </Button>
                <Button
                  {...restoreFocusTarget}
                  disabled={!active}
                  onClick={() => void capture('analyse')}
                >
                  {text('Analyse screen', 'Analisis layar')}
                </Button>
                <Button
                  {...restoreFocusTarget}
                  disabled={!active}
                  onClick={() => void capture('ask')}
                  title={settings?.hotkeys.ask}
                >
                  {text('Ask AI', 'Tanya AI')}
                </Button>
                <Button onClick={() => void refresh()}>
                  {text('Refresh', 'Perbarui')}
                </Button>
              </div>
              <DndContext
                sensors={sensors}
                onDragEnd={drop}
                accessibility={{
                  announcements,
                  screenReaderInstructions: {
                    draggable: text(
                      'Press Space to pick up a finding, arrow keys to move, Space to review a human command, or Escape to cancel. A drag never changes status directly.',
                      'Tekan Spasi untuk memilih temuan, panah untuk memindahkan, Spasi untuk meninjau perintah manusia, atau Escape untuk membatalkan. Seret tidak mengubah status secara langsung.',
                    ),
                  },
                }}
              >
                <div className="board">
                  {stages.map((stage) => (
                    <Column
                      key={stage.id}
                      stage={stage}
                      language={language}
                      count={
                        displayed.filter((card) => card.status === stage.id)
                          .length
                      }
                    >
                      {displayed
                        .filter((card) => card.status === stage.id)
                        .map((card) => (
                          <Finding
                            key={card.number}
                            card={card}
                            pending={pending.has(card.number)}
                            select={setSelected}
                          />
                        ))}
                    </Column>
                  ))}
                </div>
              </DndContext>
            </main>
            <aside className="proposal-rail">
              <h2>{text('Human review queue', 'Antrean tinjauan manusia')}</h2>
              {!queued.length && (
                <p>
                  {text(
                    'Capture, redact and analyse evidence to get a proposal. AI cannot approve, reject or dispute.',
                    'Ambil, sunting, dan analisis bukti untuk mendapatkan usulan. AI tidak dapat menyetujui, membantah, atau menyanggah.',
                  )}
                </p>
              )}
              {queued.map((item) => (
                <ProposalCard
                  key={item.id}
                  queued={item}
                  cards={cards}
                  report={report}
                  onHumanDecision={(issue, decision) => {
                    const card = cards.find((item) => item.number === issue);
                    if (!card || decision.type === 'none') return;
                    openManual(
                      card,
                      decision.type === 'approve'
                        ? '/approve'
                        : decision.type === 'reject'
                          ? '/reject'
                          : '/dispute',
                      `${decision.speaker} · ${decision.at}: ${decision.quote}`,
                    );
                  }}
                  onPosted={(issue, version) => {
                    setQueued((old) =>
                      old.filter((entry) => entry.id !== item.id),
                    );
                    markPending(issue, version);
                    void refresh();
                  }}
                  onDiscarded={() =>
                    setQueued((old) =>
                      old.filter((entry) => entry.id !== item.id),
                    )
                  }
                />
              ))}
              {recoveredPending.length > 0 && (
                <section
                  aria-label={text(
                    'Recovered pending publications',
                    'Penerbitan tertunda yang dipulihkan',
                  )}
                >
                  <h3>
                    {text(
                      'Recovered pending publications',
                      'Penerbitan tertunda yang dipulihkan',
                    )}{' '}
                    ({recoveredPending.length})
                  </h3>
                  {recoveredPending.map((item) => (
                    <article className="recovered-action" key={item.id}>
                      <p>
                        {item.kind === 'manual'
                          ? text('Human command', 'Perintah manusia')
                          : item.kind === 'proposal'
                            ? text('Reviewed proposal', 'Usulan yang ditinjau')
                            : item.kind === 'evidence'
                              ? text('Reviewed evidence', 'Bukti yang ditinjau')
                              : text(
                                  'Reviewed recap',
                                  'Ringkasan yang ditinjau',
                                )}{' '}
                        ·{' '}
                        {item.issue
                          ? `#${item.issue}`
                          : text('Session', 'Sesi')}
                      </p>
                      <p>
                        {text('Original actor', 'Pelaku asli')}: {item.actor}
                      </p>
                      <Button
                        {...restoreFocusTarget}
                        onClick={() => setRetryPending(item)}
                      >
                        {text(
                          'Review and retry saved action',
                          'Tinjau dan coba lagi tindakan tersimpan',
                        )}
                      </Button>
                    </article>
                  ))}
                </section>
              )}
            </aside>
          </div>
          {review && (
            <ReviewCapture
              snapshot={review.snapshot}
              mode={review.mode}
              cards={cards}
              initialIssue={review.issue}
              initialStep={review.step}
              close={() => setReview(undefined)}
              finish={() => setReview(undefined)}
              published={(issue, version) => {
                markPending(issue, version);
                void refresh();
              }}
              report={report}
            />
          )}
          {selected && !review && !manual && !retryPending && (
            <FindingDetail
              card={selected}
              close={() => setSelected(undefined)}
              command={openManual}
              captureStep={(issue, step) =>
                void capture('evidence', issue, step)
              }
              assist={(mode, issue) => void capture(mode, issue)}
              canCapture={active}
              completed={completedSteps}
              toggleStep={(key) =>
                setCompletedSteps((old) => {
                  const next = new Set(old);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              report={report}
            />
          )}
          {manual && (
            <Modal
              title={text(
                `Human command ${manual.command} for #${manual.issue}`,
                `Perintah manusia ${manual.command} untuk #${manual.issue}`,
              )}
              close={() => setManual(undefined)}
              returnIssue={manual.issue}
            >
              <p>
                {text(
                  'Actions enforce authorization, four-eyes and evidence. A verbal or AI proposal never signs off.',
                  'Actions menegakkan otorisasi, empat mata, dan bukti. Usulan lisan atau AI tidak pernah memberikan pengesahan.',
                )}
              </p>
              {manual.destination && (
                <p>
                  {text('Requested board stage', 'Tahap papan yang diminta')}:{' '}
                  {stageLabel(manual.destination, language)}.{' '}
                  {text(
                    'Choose the permitted command; this drag did not change status.',
                    'Pilih perintah yang diizinkan; seret ini tidak mengubah status.',
                  )}
                </p>
              )}
              <label>
                {text('Human command', 'Perintah manusia')}
                <select
                  disabled={manualBusy}
                  value={manual.command}
                  onChange={(event) => {
                    const command = z
                      .enum(humanCommands)
                      .parse(event.target.value);
                    setManual({ ...manual, command });
                    editManual();
                  }}
                >
                  {humanCommands.map((command) => (
                    <option key={command} value={command}>
                      {text(...commandLabels[command])} ({command})
                    </option>
                  ))}
                </select>
              </label>
              {manual.command === '/dispute' && (
                <>
                  <label>
                    {text('Dispute type', 'Jenis sanggahan')}
                    <select
                      disabled={manualBusy}
                      value={disputeType}
                      onChange={(event) => {
                        setDisputeType(
                          z
                            .enum([
                              'false-positive',
                              'not-applicable',
                              'risk-accepted',
                            ])
                            .parse(event.target.value),
                        );
                        editManual();
                      }}
                    >
                      <option value="false-positive">
                        {text('False positive', 'Positif palsu')}
                      </option>
                      <option value="not-applicable">
                        {text('Not applicable', 'Tidak berlaku')}
                      </option>
                      <option value="risk-accepted">
                        {text('Risk accepted', 'Risiko diterima')}
                      </option>
                    </select>
                  </label>
                  {disputeType === 'risk-accepted' && (
                    <label>
                      {text(
                        'Risk acceptance until (YYYY-MM-DD, optional)',
                        'Penerimaan risiko sampai (YYYY-MM-DD, opsional)',
                      )}
                      <Input
                        type="date"
                        value={riskUntil}
                        disabled={manualBusy}
                        onChange={(_, data) => {
                          setRiskUntil(data.value);
                          editManual();
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              <label>
                {text('Reason / validation note', 'Alasan / catatan validasi')}
                <Textarea
                  disabled={manualBusy}
                  value={reason}
                  onChange={(_, data) => {
                    setReason(data.value);
                    editManual();
                  }}
                />
              </label>
              {manual.command === '/approve' && (
                <label>
                  {text(
                    'Validated-by (optional, on behalf of)',
                    'Validated-by (opsional, atas nama)',
                  )}
                  <Input
                    disabled={manualBusy}
                    value={validator}
                    onChange={(_, data) => {
                      setValidator(data.value);
                      editManual();
                    }}
                  />
                </label>
              )}
              <h3>
                {text(
                  'Exact command to publish',
                  'Perintah persis yang akan diterbitkan',
                )}
              </h3>
              <pre className="finding-detail">
                {formatHumanCommand({
                  command: manual.command,
                  reason,
                  validator,
                  disputeType,
                  until: riskUntil,
                })}
              </pre>
              <Checkbox
                label={text(
                  'I am the signed-in human and reviewed the finding, evidence and this command.',
                  'Saya adalah manusia yang masuk dan telah meninjau temuan, bukti, serta perintah ini.',
                )}
                disabled={manualBusy}
                checked={humanReviewed}
                onChange={(_, data) => setHumanReviewed(data.checked === true)}
              />
              <Button
                appearance="primary"
                disabled={
                  !humanReviewed ||
                  manualBusy ||
                  (['/reject', '/dispute', '/block', '/reopen'].includes(
                    manual.command,
                  ) &&
                    !reason.trim())
                }
                onClick={() => void postManual()}
              >
                {manualBusy
                  ? text('Posting...', 'Mengirim...')
                  : text('Post human command', 'Kirim perintah manusia')}
              </Button>
            </Modal>
          )}
          {exportOpen && settings && (
            <ExportReview
              key={`${settings.githubRepo}:${settings.exportDir}`}
              destination={settings.exportDir}
              repository={settings.githubRepo}
              close={() => setExportOpen(false)}
            />
          )}
          {settingsOpen && form && (
            <Modal
              title={text(
                'Encrypted connection settings',
                'Pengaturan koneksi terenkripsi',
              )}
              close={closeSettings}
            >
              <p>
                {text(
                  'Credentials stay in the main process and OS-encrypted storage. Entra ID via az login is preferred. API-key mode must be selected explicitly; blank secret fields keep stored credentials.',
                  'Kredensial tetap di proses utama dan penyimpanan terenkripsi OS. Entra ID melalui az login diutamakan. Mode kunci API harus dipilih secara eksplisit; kolom rahasia kosong mempertahankan kredensial tersimpan.',
                )}
              </p>
              <label>
                {text('Foundry authentication', 'Autentikasi Foundry')}
                <select
                  disabled={settingsBusy}
                  value={form.authMode}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      authMode:
                        event.target.value === 'key' ? 'key' : 'identity',
                      apiKey: undefined,
                    })
                  }
                >
                  <option value="identity">
                    {text(
                      'Microsoft Entra ID (preferred)',
                      'Microsoft Entra ID (diutamakan)',
                    )}
                  </option>
                  <option value="key">
                    {text(
                      'Explicit API-key fallback',
                      'Alternatif kunci API eksplisit',
                    )}
                  </option>
                </select>
              </label>
              {(
                [
                  'endpoint',
                  'chatDeployment',
                  'transcribeDeployment',
                  'realtimeDeployment',
                  'githubRepo',
                  'exportDir',
                ] as const
              ).map((key) => (
                <label key={key}>
                  {text(
                    ...(
                      {
                        endpoint: ['Foundry endpoint', 'Endpoint Foundry'],
                        chatDeployment: [
                          'Chat deployment',
                          'Deployment percakapan',
                        ],
                        transcribeDeployment: [
                          'Transcription deployment',
                          'Deployment transkripsi',
                        ],
                        realtimeDeployment: [
                          'Realtime transcription deployment',
                          'Deployment transkripsi waktu nyata',
                        ],
                        githubRepo: ['GitHub repository', 'Repositori GitHub'],
                        exportDir: [
                          'Local export folder',
                          'Folder ekspor lokal',
                        ],
                      } satisfies Record<typeof key, [string, string]>
                    )[key],
                  )}
                  <Input
                    disabled={settingsBusy}
                    value={form[key]}
                    onChange={(_, data) =>
                      setForm({ ...form, [key]: data.value })
                    }
                  />
                </label>
              ))}
              {form.authMode === 'key' && (
                <label>
                  {text(
                    'Foundry API key (blank keeps stored key)',
                    'Kunci API Foundry (kosong mempertahankan kunci tersimpan)',
                  )}{' '}
                  ·{' '}
                  {settings?.hasKey
                    ? text('stored', 'tersimpan')
                    : text('not stored', 'belum tersimpan')}
                  <Input
                    disabled={settingsBusy}
                    type="password"
                    value={form.apiKey || ''}
                    onChange={(_, data) =>
                      setForm({ ...form, apiKey: data.value })
                    }
                  />
                </label>
              )}
              <label>
                {text(
                  'GitHub PAT (optional; otherwise gh auth token)',
                  'GitHub PAT (opsional; jika kosong gunakan gh auth token)',
                )}
                <Input
                  disabled={settingsBusy}
                  type="password"
                  value={form.githubToken || ''}
                  onChange={(_, data) =>
                    setForm({ ...form, githubToken: data.value })
                  }
                />
              </label>
              <h3>
                {text(
                  'Retention and session budgets',
                  'Retensi dan batas sesi',
                )}
              </h3>
              <p>
                {text(
                  'Only local appearance preferences are stored in the renderer. Retention, budgets and hotkeys are validated and saved by the main process.',
                  'Hanya preferensi tampilan lokal yang disimpan di renderer. Retensi, batas, dan pintasan divalidasi serta disimpan oleh proses utama.',
                )}
              </p>
              {(
                [
                  [
                    'retentionDays',
                    1,
                    365,
                    1,
                    'Local retention days',
                    'Hari retensi lokal',
                  ],
                  [
                    'maxImagesPerSession',
                    1,
                    1000,
                    1,
                    'Maximum images per session',
                    'Maksimal gambar per sesi',
                  ],
                  [
                    'maxAnalysesPerMinute',
                    1,
                    6,
                    1,
                    'Maximum analyses per minute',
                    'Maksimal analisis per menit',
                  ],
                  [
                    'maxTokensPerSession',
                    16000,
                    1000000,
                    1000,
                    'Maximum tokens per session',
                    'Maksimal token per sesi',
                  ],
                ] as const
              ).map(([key, min, max, step, en, id]) => (
                <label key={key}>
                  {text(en, id)} ({min}–{max})
                  <Input
                    type="number"
                    value={String(form[key])}
                    min={min}
                    max={max}
                    step={step}
                    disabled={settingsBusy}
                    onChange={(_, data) =>
                      setForm({ ...form, [key]: Number(data.value) })
                    }
                  />
                </label>
              ))}
              <h3>
                {text(
                  'Global keyboard shortcuts',
                  'Pintasan papan ketik global',
                )}
              </h3>
              {(
                [
                  [
                    'evidence',
                    'Evidence capture shortcut',
                    'Pintasan pengambilan bukti',
                  ],
                  ['ask', 'Ask AI shortcut', 'Pintasan tanya AI'],
                  [
                    'pause',
                    'Pause / Private shortcut',
                    'Pintasan jeda / privat',
                  ],
                  [
                    'presenter',
                    'Presenter view shortcut',
                    'Pintasan tampilan presenter',
                  ],
                ] as const
              ).map(([key, en, id]) => (
                <label key={key}>
                  {text(en, id)}
                  <Input
                    value={form.hotkeys[key]}
                    maxLength={80}
                    disabled={settingsBusy}
                    onChange={(_, data) =>
                      setForm({
                        ...form,
                        hotkeys: { ...form.hotkeys, [key]: data.value },
                      })
                    }
                  />
                </label>
              ))}
              <Button
                appearance="primary"
                disabled={settingsBusy}
                onClick={() =>
                  void (async () => {
                    setSettingsBusy(true);
                    try {
                      const loaded = value(
                        await api.saveSettings(settingsInputSchema.parse(form)),
                      );
                      setSettings(loaded);
                      setForm(settingsInputSchema.strip().parse(loaded));
                      resetRecap();
                      setSettingsOpen(false);
                      void refresh();
                    } catch (error) {
                      report(
                        error instanceof Error
                          ? error.message
                          : text(
                              'Encrypted settings could not be saved.',
                              'Pengaturan terenkripsi tidak dapat disimpan.',
                            ),
                      );
                    } finally {
                      setSettingsBusy(false);
                    }
                  })()
                }
              >
                {text(
                  'Save encrypted settings',
                  'Simpan pengaturan terenkripsi',
                )}
              </Button>
            </Modal>
          )}
          {recapOpen && currentRecap !== undefined && (
            <Modal
              title={text(
                'Review session recap before publishing',
                'Tinjau ringkasan sesi sebelum diterbitkan',
              )}
              close={() => setRecapOpen(false)}
            >
              <p>
                {text(
                  'This recap is data, not workflow authority. Verbal decisions still require an explicit human command.',
                  'Ringkasan ini adalah data, bukan otoritas alur kerja. Keputusan lisan tetap memerlukan perintah manusia secara eksplisit.',
                )}
              </p>
              <p>
                {text('Recap session', 'Sesi ringkasan')}:{' '}
                <code>{currentRecap.session}</code>
              </p>
              <Textarea
                aria-label={text('Session recap text', 'Teks ringkasan sesi')}
                disabled={recapBusy}
                value={currentRecap.text}
                onChange={(_, data) => {
                  if (sessionRef.current !== currentRecap.session) return;
                  setRecap({ ...currentRecap, text: data.value });
                  setRecapReviewed(false);
                }}
                resize="vertical"
              />
              <Checkbox
                label={text(
                  'I reviewed/redacted this recap and approve publication to the configured repository.',
                  'Saya meninjau/menyunting ringkasan ini dan menyetujui penerbitannya ke repositori yang dikonfigurasi.',
                )}
                disabled={recapBusy}
                checked={recapReviewed}
                onChange={(_, data) => {
                  if (sessionRef.current === currentRecap.session)
                    setRecapReviewed(data.checked === true);
                }}
              />
              <Button
                appearance="primary"
                disabled={
                  !recapReviewed ||
                  recapBusy ||
                  !currentRecap.text.trim() ||
                  phase !== 'stopped'
                }
                onClick={() => void publishRecap()}
              >
                {text(
                  'Publish reviewed recap',
                  'Terbitkan ringkasan yang ditinjau',
                )}
              </Button>
            </Modal>
          )}
          {retryPending && (
            <RetryPublication
              key={retryPending.id}
              pending={retryPending}
              close={() => setRetryPending(undefined)}
              report={report}
              retried={(item) => {
                setRecoveredPending((old) =>
                  old.filter((pending) => pending.id !== item.id),
                );
                setQueued((old) =>
                  old.filter((proposal) => proposal.id !== item.id),
                );
                setRetryPending(undefined);
                void refresh();
              }}
            />
          )}
        </div>
      </ViewContext.Provider>
    </FluentProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The Pronoia root element is missing.');
createRoot(root).render(<App />);
