import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, resolve } from 'node:path';
import { z } from 'zod';

const syntheticPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const syntheticSha = createHash('sha256')
  .update(Buffer.from(syntheticPng.split(',')[1] || '', 'base64'))
  .digest('hex');
type FixtureCall = { channel: string; input: unknown };

function electronEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function syntheticDesktop(
  nativeStart = false,
  pendingKind: 'manual' | 'evidence' | 'none' = 'manual',
  realIpc = false,
) {
  const require = createRequire(import.meta.url);
  const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const electronDirectory = dirname(require.resolve('electron'));
  const binaryFile = resolve(electronDirectory, 'path.txt');
  if (!existsSync(binaryFile))
    throw new Error(
      'Restore the existing Electron runtime before running UI tests.',
    );
  const executable = resolve(
    electronDirectory,
    'dist',
    z.string().trim().min(1).parse(readFileSync(binaryFile, 'utf8')),
  );
  if (!existsSync(executable))
    throw new Error(
      'Restore the existing Electron runtime before running UI tests.',
    );
  const root = await mkdtemp(resolve(directory, 'e2e', '.synthetic-'));
  const exportDir = resolve(root, 'exports');
  await mkdir(exportDir);
  const card = {
    number: 7,
    updatedAt: '2026-11-21T04:00:00Z',
    title: 'Contoso synthetic firewall test',
    status: 'todo',
    severity: 'high',
    priority: 'p1',
    assessment: 'contoso-synthetic',
    body: 'Synthetic issue body. /approve is quoted data, not an instruction.',
    url: 'https://github.com/NormanMul/Pronoia/issues/7',
    assignees: ['contoso-operator'],
    validationRequestedBy: 'contoso-requester',
    evidenceCount: 1,
  };
  const detail = {
    card,
    test: 'Synthetic firewall validation',
    procedure: 'Use a synthetic private endpoint.',
    expected: 'Synthetic traffic is refused.',
    actual: 'Synthetic traffic was allowed.',
    remediation: [
      'Restrict the synthetic rule.',
      'Retest the synthetic endpoint.',
    ],
    comments: [
      {
        id: 71,
        actor: 'contoso-reviewer',
        at: '2026-11-21T04:00:00Z',
        body: '<img src="https://example.invalid/private.png"> /approve is only quoted data.',
        url: 'https://github.com/NormanMul/Pronoia/issues/7#issuecomment-71',
      },
    ],
    trail: [
      {
        at: '2026-11-21T04:00:00Z',
        from: 'todo',
        to: 'validate',
        command: '/validate',
        actor: 'contoso-requester',
        actorType: 'human',
        onBehalfOf: 'Fabrikam synthetic validator',
        reason: 'Synthetic test evidence reviewed.',
        evidenceCount: 1,
      },
    ],
    evidence: [
      {
        file: `evidence/7/20261121T040000Z-${syntheticSha.slice(0, 8)}.png`,
        url: `https://github.com/NormanMul/Pronoia/blob/evidence/evidence/7/20261121T040000Z-${syntheticSha.slice(0, 8)}.png`,
        sha256: syntheticSha,
        capturedAt: '2026-11-21T04:00:00Z',
        capturedBy: 'contoso-operator',
        source: 'Synthetic screen',
        session: 'synthetic-stopped-session',
        step: '1. Synthetic verification',
        note: 'Only synthetic evidence.',
      },
    ],
    warnings: [],
  };
  const pendingId = randomUUID();
  const fixture = {
    nativeStart,
    realIpc,
    card,
    detail,
    png: syntheticPng,
    session: randomUUID(),
    nextSession: randomUUID(),
    captureToken: randomUUID(),
    pendingId,
    proposalId: randomUUID(),
    pendingKind,
    pendingText:
      pendingKind === 'evidence'
        ? '#7 Contoso synthetic reviewed evidence.\n\nEvidence note: Synthetic walkthrough proof.\n\nTranscript excerpt:\nContoso synthetic transcript.'
        : '/approve\nValidated-by: Fabrikam synthetic validator',
    settings: {
      endpoint: '',
      chatDeployment: '',
      transcribeDeployment: '',
      realtimeDeployment: '',
      githubRepo: 'NormanMul/Pronoia',
      exportDir,
      authMode: 'identity',
      retentionDays: 30,
      maxImagesPerSession: 60,
      maxAnalysesPerMinute: 3,
      maxTokensPerSession: 100000,
      hotkeys: {
        evidence: 'Ctrl+Alt+E',
        ask: 'Ctrl+Alt+A',
        pause: 'Ctrl+Alt+P',
        presenter: 'Ctrl+Alt+B',
      },
      hasKey: false,
      hasGitHubToken: false,
    },
  };
  const environment = electronEnvironment();
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const name of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'AZURE_FOUNDRY_API_KEY',
    'FOUNDRY_API_KEY',
    'AZURE_FOUNDRY_ENDPOINT',
    'FOUNDRY_CHAT_DEPLOYMENT',
    'FOUNDRY_TRANSCRIBE_DEPLOYMENT',
    'FOUNDRY_REALTIME_TRANSCRIBE_DEPLOYMENT',
  ])
    delete environment[name];
  environment.PRONOIA_USER_DATA_DIR = root;
  environment.PRONOIA_EXPORT_DIR = exportDir;
  for (const name of Object.keys(environment))
    if (name.toLowerCase() === 'path') delete environment[name];
  environment.PATH = [
    dirname(process.execPath),
    dirname(executable),
    resolve(environment.SystemRoot || 'C:\\Windows', 'System32'),
  ].join(delimiter);
  let application: ElectronApplication;
  try {
    application = await _electron.launch({
      args: [directory],
      env: environment,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let page: Page;
  try {
    page = await application.firstWindow();
    await page.waitForURL('**/index.html', { waitUntil: 'load' });
    expect(
      await application.evaluate(async ({ app }) => {
        await app.whenReady();
        return app.getPath('userData');
      }),
    ).toBe(root);
    await application.evaluate(async ({ app, ipcMain, session }, fixture) => {
      await app.whenReady();
      if (fixture.realIpc) return;
      const requireModule = process
        .getBuiltinModule('module')
        .createRequire(
          process
            .getBuiltinModule('path')
            .join(app.getAppPath(), 'package.json'),
        );
      const { z } = requireModule('zod') as typeof import('zod');
      const state = {
        calls: [] as FixtureCall[],
        manualFailures: 2,
        phase: 'stopped',
        session: fixture.session,
        staleRecapOnce: false,
      };
      Object.assign(globalThis, { pronoiaSynthetic: state });
      const ok = (value: unknown) => ({ ok: true, value });
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
        (_, callback) => callback({ cancel: true }),
      );
      for (const action of [
        'settings',
        'sources',
        'board',
        'item',
        'evidence-preview',
        'recovery',
        'manual',
        'retry-publication',
        'publish-evidence',
        'start',
        'activate',
        'pause',
        'stop',
        'snapshot',
        'open',
        'presenter',
        'compact',
        'always-on-top',
        'analyse',
        'ask',
        'post',
        'discard',
        'recap',
        'publish-recap',
        'media-token',
        'audio',
        'pcm',
        'copy-notice',
        'save-settings',
      ]) {
        if (
          fixture.nativeStart &&
          (action === 'start' || action === 'media-token')
        )
          continue;
        const channel = `pronoia:${action}`;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, input: unknown) => {
          state.calls.push({ channel, input });
          const emitPhase = (phase: string) => {
            state.phase = phase;
            event.sender.send('pronoia:event', {
              type: 'phase',
              phase,
              session: state.session,
            });
          };
          switch (action) {
            case 'settings':
              return ok(fixture.settings);
            case 'sources':
              return ok([{ id: 'synthetic-screen', name: 'Synthetic screen' }]);
            case 'board':
              return ok({
                cards: [fixture.card],
                login: 'contoso-reviewer',
                publicRepo: true,
              });
            case 'item':
              return ok({ ...fixture.detail, card: fixture.card });
            case 'evidence-preview':
              return ok(fixture.png);
            case 'recovery':
              return ok({
                session: fixture.session,
                phase: 'stopped',
                proposals: [],
                recap: 'Contoso synthetic stopped-session recap.',
                pending:
                  fixture.pendingKind === 'none'
                    ? []
                    : [
                        {
                          id: fixture.pendingId,
                          kind: fixture.pendingKind,
                          issue: 7,
                          actor: 'contoso-reviewer',
                          text: fixture.pendingText,
                          image: fixture.png,
                        },
                      ],
              });
            case 'manual':
              if (state.manualFailures-- > 0)
                return {
                  ok: false,
                  error: {
                    code: 'SYNTHETIC_RETRY',
                    message:
                      'Synthetic retryable error; no external publication.',
                  },
                };
              fixture.card.updatedAt = '2026-11-21T04:00:01Z';
              return ok({ url: fixture.card.url });
            case 'retry-publication':
            case 'publish-evidence':
              fixture.card.updatedAt = '2026-11-21T04:00:01Z';
              return ok({ url: fixture.card.url });
            case 'start':
              state.session = fixture.nextSession;
              emitPhase('starting');
              return ok({ session: state.session, platform: 'win32' });
            case 'activate':
              emitPhase('active');
              return ok(undefined);
            case 'media-token':
              return z.object({ session: z.string() }).strict().parse(input)
                .session === state.session &&
                ['starting', 'active'].includes(state.phase)
                ? ok(fixture.captureToken)
                : {
                    ok: false,
                    error: {
                      code: 'SYNTHETIC_CAPTURE_INACTIVE',
                      message: 'The synthetic capture is not active.',
                    },
                  };
            case 'pause':
              emitPhase(
                z.object({ paused: z.boolean() }).parse(input).paused
                  ? 'paused'
                  : 'starting',
              );
              return ok(undefined);
            case 'stop':
              emitPhase('stopped');
              return ok(undefined);
            case 'snapshot':
              return ok({
                id: 'synthetic-capture',
                image: fixture.png,
                width: 1,
                height: 1,
                capturedAt: '2026-11-21T04:00:00Z',
                source: 'Synthetic screen',
                transcript: 'Contoso synthetic transcript.',
              });
            case 'recap': {
              if (state.staleRecapOnce) {
                state.staleRecapOnce = false;
                return ok({
                  session: fixture.session,
                  text: 'Contoso synthetic stopped-session recap.',
                });
              }
              return ok({
                session: state.session,
                text: 'Contoso synthetic recap for session B.',
              });
            }
            case 'publish-recap': {
              const publication = z
                .object({
                  session: z.string(),
                  text: z.string(),
                  reviewed: z.literal(true),
                })
                .strict()
                .parse(input);
              return publication.session === state.session &&
                state.phase === 'stopped'
                ? ok({ url: fixture.card.url })
                : {
                    ok: false,
                    error: {
                      code: 'SYNTHETIC_RECAP_SCOPE',
                      message:
                        'The synthetic recap origin does not match the stopped session.',
                    },
                  };
            }
            case 'ask':
              return ok('Contoso synthetic answer; no external model call.');
            case 'analyse': {
              const target = z
                .object({ issue: z.number().positive().optional() })
                .passthrough()
                .parse(input);
              const queued = {
                id: fixture.proposalId,
                snapshot: 'synthetic-capture',
                image: fixture.png,
                warnings: [],
                proposal: {
                  issue: target.issue || 7,
                  observed: 'Contoso synthetic observation.',
                  result: 'unclear',
                  proposed_command: 'none',
                  reason: 'Synthetic review only.',
                  remediation: [],
                  evidence_note: 'Synthetic reviewed image.',
                  verbal_decision: {
                    type: 'none',
                    speaker: '',
                    quote: '',
                    at: '',
                  },
                  confidence: 0.5,
                },
              };
              event.sender.send('pronoia:event', {
                type: 'proposal',
                proposal: queued,
              });
              return ok(queued);
            }
            case 'open':
            case 'presenter':
            case 'compact':
            case 'always-on-top':
              return ok(undefined);
            default:
              return {
                ok: false,
                error: {
                  code: 'SYNTHETIC_ONLY',
                  message:
                    'External calls are disabled in this synthetic fixture.',
                },
              };
          }
        });
      }
    }, fixture);
    await application.evaluate(async ({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      if (!window) throw new Error('The synthetic test window is unavailable.');
      await new Promise<void>((resolve) => {
        window.webContents.once('did-finish-load', () => resolve());
        window.webContents.reload();
      });
    });
  } catch (error) {
    try {
      await application.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    application,
    page,
    pendingId,
    exportDir,
    sessionA: fixture.session,
    sessionB: fixture.nextSession,
    calls: () =>
      application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              pronoiaSynthetic: { calls: FixtureCall[] };
            }
          ).pronoiaSynthetic.calls,
      ),
    close: async () => {
      try {
        await application.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function consent(page: Page) {
  await page
    .getByRole('checkbox', {
      name: 'All participants were told this session is transcribed and screenshots are captured.',
      exact: true,
    })
    .check();
  await page
    .getByRole('checkbox', {
      name: 'Participants approved cloud processing in the configured Foundry region.',
      exact: true,
    })
    .check();
  await page
    .getByRole('checkbox', {
      name: 'Only synthetic demo data will be captured/published in this public repository.',
      exact: true,
    })
    .check();
}

test('real IPC refuses start B during recap A publication preflight and preserves A metadata', async () => {
  const fixture = await syntheticDesktop(true, 'none', true);
  let publication: Promise<unknown> | undefined;
  try {
    await fixture.application.evaluate(({ app }) => {
      const requireModule = process
        .getBuiltinModule('module')
        .createRequire(
          process
            .getBuiltinModule('path')
            .join(app.getAppPath(), 'package.json'),
        );
      const { z } = requireModule('zod') as typeof import('zod');
      let releaseUser: () => void = () => undefined;
      let markHeld: () => void = () => undefined;
      const state = {
        holdNextUser: false,
        held: new Promise<void>((resolve) => {
          markHeld = resolve;
        }),
        release: () => releaseUser(),
        creates: [] as { path: string; text: string }[],
      };
      Object.assign(globalThis, { pronoiaPublicationRace: state });
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const method =
          init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.hostname !== 'api.github.com')
          throw new Error('Only synthetic GitHub HTTP is allowed.');
        const reply = (body: unknown, status = 200) =>
          Response.json(body, { status });
        if (method === 'GET' && url.pathname === '/user') {
          if (state.holdNextUser) {
            state.holdNextUser = false;
            await new Promise<void>((resolve) => {
              releaseUser = resolve;
              markHeld();
            });
          }
          return reply({ login: 'synthetic-operator', type: 'User' });
        }
        if (method === 'GET' && url.pathname === '/repos/NormanMul/Pronoia')
          return reply({ private: false });
        if (
          method === 'GET' &&
          url.pathname === '/repos/NormanMul/Pronoia/issues'
        )
          return reply([]);
        const prefix = '/repos/NormanMul/Pronoia/contents/';
        if (url.pathname.startsWith(prefix)) {
          if (method === 'GET')
            return reply({ message: 'Synthetic file is absent.' }, 404);
          if (method === 'PUT') {
            const body = z
              .object({ content: z.string() })
              .passthrough()
              .parse(JSON.parse(z.string().parse(init?.body)));
            const path = decodeURIComponent(url.pathname.slice(prefix.length));
            state.creates.push({
              path,
              text: Buffer.from(body.content, 'base64').toString('utf8'),
            });
            return reply({ content: { path } }, 201);
          }
        }
        throw new Error(`Unexpected synthetic HTTP: ${method} ${url.pathname}`);
      };
    });
    const saved = await fixture.page.evaluate(async (exportDir) => {
      const loaded = await window.pronoia.settings();
      if (!loaded.ok) throw new Error(loaded.error.message);
      const { hasKey, hasGitHubToken, ...settings } = loaded.value;
      void hasKey;
      void hasGitHubToken;
      return window.pronoia.saveSettings({
        ...settings,
        githubRepo: 'NormanMul/Pronoia',
        exportDir,
        githubToken: 'local-synthetic-token-not-a-secret',
      });
    }, fixture.exportDir);
    expect(saved.ok).toBe(true);
    const sources = await fixture.page.evaluate(() => window.pronoia.sources());
    if (!sources.ok) throw new Error(sources.error.message);
    const source = sources.value[0];
    if (!source)
      throw new Error(
        'A source ID is required; no media or screenshot will be captured.',
      );
    const base = {
      participantsNotified: true,
      cloudApproved: true,
      synthetic: true,
      sourceId: source.id,
      issues: [],
      microphone: false,
      systemAudio: false,
      provider: 'batch' as const,
      autoWatch: false,
    };
    const started = await fixture.page.evaluate(
      (input) => window.pronoia.start(input),
      { ...base, assessment: 'Contoso A' },
    );
    if (!started.ok) throw new Error(started.error.message);
    const sessionA = started.value.session;
    expect(
      (
        await fixture.page.evaluate(
          (session) => window.pronoia.activate(session),
          sessionA,
        )
      ).ok,
    ).toBe(true);
    expect((await fixture.page.evaluate(() => window.pronoia.stop())).ok).toBe(
      true,
    );
    await fixture.application.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          pronoiaPublicationRace: { holdNextUser: boolean };
        }
      ).pronoiaPublicationRace.holdNextUser = true;
    });
    publication = fixture.page.evaluate(
      (session) =>
        window.pronoia.publishRecap({
          session,
          text: 'Contoso recap A',
          reviewed: true,
        }),
      sessionA,
    );
    await fixture.application.evaluate(async () => {
      await (
        globalThis as typeof globalThis & {
          pronoiaPublicationRace: { held: Promise<void> };
        }
      ).pronoiaPublicationRace.held;
    });
    const startB = await fixture.page.evaluate(
      (input) => window.pronoia.start(input),
      { ...base, assessment: 'Fabrikam B' },
    );
    await fixture.application.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          pronoiaPublicationRace: { release: () => void };
        }
      ).pronoiaPublicationRace.release();
    });
    const result = await publication;
    const created = await fixture.application.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            pronoiaPublicationRace: {
              creates: { path: string; text: string }[];
            };
          }
        ).pronoiaPublicationRace.creates,
    );
    if (startB.ok)
      console.log('Publication race reproduced:', {
        sessionA,
        acceptedSessionB: startB.value.session,
        created,
      });
    expect(
      startB.ok,
      'Start B must refuse before recap A publication preparation performs its first await.',
    ).toBe(false);
    expect(result).toMatchObject({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]?.path).toMatch(
      new RegExp(`^sessions/\\d{4}-\\d{2}-\\d{2}-${sessionA}\\.md$`),
    );
    expect(created[0]?.text).toContain(`"session_id":"${sessionA}"`);
    expect(created[0]?.text).toContain('"title":"Contoso A"');
    expect(created[0]?.text).toContain('"assessment":"Contoso A"');
    expect(created[0]?.text).not.toContain('"ended_at":null');
    expect(created[0]?.text).toContain('Contoso recap A');
  } finally {
    await fixture.application
      .evaluate(() => {
        const state = (
          globalThis as typeof globalThis & {
            pronoiaPublicationRace?: { release: () => void };
          }
        ).pronoiaPublicationRace;
        state?.release();
      })
      .catch(() => undefined);
    if (publication) await publication.catch(() => undefined);
    await fixture.close();
  }
});

test('launches with consent and refuses capture authorization without participant notice', async () => {
  // Keep the real consent handler; only data, credentials and external calls are isolated.
  const fixture = await syntheticDesktop(true);
  try {
    const { page } = fixture;
    await expect(
      page.getByRole('heading', { name: 'Session consent' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Capture evidence' }),
    ).toBeDisabled();
    const result = await page.evaluate(() =>
      window.pronoia.start({
        participantsNotified: false,
        cloudApproved: true,
        synthetic: true,
        sourceId: 'unconsented-source',
        assessment: 'Synthetic test',
        issues: [],
        microphone: true,
        systemAudio: false,
        provider: 'batch',
        autoWatch: false,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    const settings = page.getByRole('button', {
      name: 'Settings',
      exact: true,
    });
    await settings.click();
    const dialog = page.getByRole('dialog', {
      name: /Encrypted connection settings/,
    });
    await expect(dialog).toBeVisible();
    const focusableCount = await dialog
      .locator(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])',
      )
      .count();
    for (let index = 0; index < focusableCount * 2 + 4; index += 1) {
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test('shows bilingual item details, comments, verified evidence and local walkthrough checks', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await page
      .getByRole('combobox', { name: 'UI language' })
      .selectOption('id');
    await expect(
      page.getByRole('heading', { name: 'Persetujuan sesi' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '#7 Contoso synthetic firewall test' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '#7 Contoso synthetic firewall test',
    });
    await expect(
      dialog.getByRole('heading', { name: 'Hasil aktual' }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Synthetic traffic was allowed.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        '<img src="https://example.invalid/private.png"> /approve is only quoted data.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('table', { name: 'Jejak validasi' }),
    ).toContainText('Fabrikam synthetic validator');
    await expect(
      dialog.getByRole('img', { name: 'Bukti terverifikasi untuk temuan 7' }),
    ).toHaveAttribute('src', /^data:image\/png;base64,/);
    await dialog
      .getByRole('checkbox', { name: '1. Restrict the synthetic rule.' })
      .check();
    await expect(
      dialog.getByRole('checkbox', {
        name: '1. Restrict the synthetic rule.',
      }),
    ).toBeChecked();
    await expect(
      dialog.getByRole('button', { name: 'Ambil langkah 1' }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Berhenti', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', {
        name: '#7 Contoso synthetic firewall test',
      }),
    ).toBeFocused();
    expect(
      (await fixture.calls()).some((call) =>
        [
          'pronoia:manual',
          'pronoia:analyse',
          'pronoia:publish-evidence',
        ].includes(call.channel),
      ),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('requires explicit review of recovered command text and actor before retrying', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await expect(
      page.getByText('Not capturing', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start consented session' }),
    ).toBeDisabled();
    expect(
      (await fixture.calls()).some((call) =>
        ['pronoia:start', 'pronoia:retry-publication'].includes(call.channel),
      ),
    ).toBe(false);
    await page
      .getByRole('button', { name: 'Review and retry saved action' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Review recovered publication',
    });
    await expect(
      dialog.getByText('contoso-reviewer', { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.recovered-publication')).toHaveText(
      '/approve\nValidated-by: Fabrikam synthetic validator',
    );
    await expect(
      dialog.getByRole('img', {
        name: 'Reviewed image for recovered publication',
      }),
    ).toHaveAttribute('src', /^data:image\/png;base64,/);
    const retry = dialog.getByRole('button', {
      name: 'Retry exact reviewed publication',
    });
    await expect(retry).toBeDisabled();
    await dialog
      .getByRole('checkbox', { name: /I am the original signed-in human/ })
      .check();
    await retry.click();
    await expect(dialog).toBeHidden();
    const calls = (await fixture.calls()).filter(
      (call) => call.channel === 'pronoia:retry-publication',
    );
    expect(calls).toEqual([
      {
        channel: 'pronoia:retry-publication',
        input: { id: fixture.pendingId, reviewed: true },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test('formats disputes, keeps retry IDs and renews reviewed requests after editing', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await page
      .getByRole('button', { name: '#7 Contoso synthetic firewall test' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Dispute', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Human command /dispute for #7',
    });
    await dialog.getByLabel('Dispute type').selectOption('risk-accepted');
    await dialog
      .getByLabel('Risk acceptance until (YYYY-MM-DD, optional)')
      .fill('2026-12-31');
    await dialog
      .getByLabel('Reason / validation note')
      .fill('Synthetic compensating controls.');
    await expect(dialog.locator('pre')).toHaveText(
      '/dispute risk-accepted until=2026-12-31 Synthetic compensating controls.',
    );
    const reviewed = dialog.getByRole('checkbox', {
      name: /I am the signed-in human/,
    });
    const post = dialog.getByRole('button', { name: 'Post human command' });
    await expect(post).toBeDisabled();
    await reviewed.check();
    await post.click();
    await expect(page.getByRole('alert')).toContainText(
      'Synthetic retryable error',
    );
    await expect(post).toBeEnabled();
    await post.click();
    await expect(post).toBeEnabled();
    await dialog
      .getByLabel('Reason / validation note')
      .fill('Synthetic amended controls.');
    await expect(reviewed).not.toBeChecked();
    await reviewed.check();
    await post.click();
    await expect(dialog).toBeHidden();
    const requests = (await fixture.calls())
      .filter((call) => call.channel === 'pronoia:manual')
      .map((call) =>
        z
          .object({
            id: z.uuid(),
            issue: z.number(),
            body: z.string(),
            reviewed: z.literal(true),
          })
          .parse(call.input),
      );
    expect(requests).toHaveLength(3);
    expect(requests[1]?.id).toBe(requests[0]?.id);
    expect(requests[2]?.id).not.toBe(requests[0]?.id);
    expect(requests[2]?.body).toBe(
      '/dispute risk-accepted until=2026-12-31 Synthetic amended controls.',
    );
    await expect(
      page.getByText('Pending workflow', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('shows the complete recovered evidence transcript before explicit human retry', async () => {
  const fixture = await syntheticDesktop(false, 'evidence');
  try {
    const { page } = fixture;
    await page
      .getByRole('button', {
        name: 'Review and retry saved action',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Review recovered publication',
    });
    const preview = dialog.locator('.recovered-publication');
    await expect(preview).toContainText(
      'Evidence note: Synthetic walkthrough proof.',
    );
    await expect(preview).toContainText(
      'Transcript excerpt:\nContoso synthetic transcript.',
    );
    await expect(preview).toBeVisible();
    await expect(
      dialog.getByText('contoso-reviewer', { exact: true }),
    ).toBeVisible();
    const retry = dialog.getByRole('button', {
      name: 'Retry exact reviewed publication',
    });
    await expect(retry).toBeDisabled();
    expect(
      (await fixture.calls()).some(
        (call) => call.channel === 'pronoia:retry-publication',
      ),
    ).toBe(false);
    await dialog
      .getByRole('checkbox', { name: /I am the original signed-in human/ })
      .check();
    await retry.click();
    await expect(dialog).toBeHidden();
    expect(
      (await fixture.calls()).filter(
        (call) => call.channel === 'pronoia:retry-publication',
      ),
    ).toEqual([
      {
        channel: 'pronoia:retry-publication',
        input: { id: fixture.pendingId, reviewed: true },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test('clears session A recap and review consent on start B and refuses a stale A recap response', async () => {
  const fixture = await syntheticDesktop(false, 'none');
  try {
    const { page } = fixture;
    await page
      .getByRole('button', { name: 'Review recovered recap', exact: true })
      .click();
    let dialog = page.getByRole('dialog', {
      name: 'Review session recap before publishing',
    });
    await expect(dialog.getByLabel('Session recap text')).toHaveValue(
      'Contoso synthetic stopped-session recap.',
    );
    await expect(
      dialog.getByText(fixture.sessionA, { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole('checkbox', { name: /I reviewed\/redacted this recap/ })
      .check();
    await dialog
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();

    await consent(page);
    await page
      .getByRole('checkbox', { name: 'Microphone (You)', exact: true })
      .uncheck();
    await page
      .getByRole('checkbox', {
        name: 'System audio (Meeting; Windows is system-wide)',
        exact: true,
      })
      .uncheck();
    await page
      .getByRole('button', { name: 'Start consented session', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Review recovered recap', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Review saved recap', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await fixture.application.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          pronoiaSynthetic: { staleRecapOnce: boolean };
        }
      ).pronoiaSynthetic.staleRecapOnce = true;
    });
    await page
      .getByRole('button', { name: 'Draft session recap', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'This recap belongs to another session.',
    );
    await expect(
      page.getByRole('dialog', {
        name: 'Review session recap before publishing',
      }),
    ).toHaveCount(0);

    await page
      .getByRole('button', { name: 'Draft session recap', exact: true })
      .click();
    dialog = page.getByRole('dialog', {
      name: 'Review session recap before publishing',
    });
    await expect(
      dialog.getByText(fixture.sessionB, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Session recap text')).toHaveValue(
      'Contoso synthetic recap for session B.',
    );
    const reviewed = dialog.getByRole('checkbox', {
      name: /I reviewed\/redacted this recap/,
    });
    await expect(reviewed).not.toBeChecked();
    const publish = dialog.getByRole('button', {
      name: 'Publish reviewed recap',
      exact: true,
    });
    await expect(publish).toBeDisabled();
    await reviewed.check();
    await publish.click();
    await expect(dialog).toBeHidden();
    expect(
      (await fixture.calls()).filter(
        (call) => call.channel === 'pronoia:publish-recap',
      ),
    ).toEqual([
      {
        channel: 'pronoia:publish-recap',
        input: {
          session: fixture.sessionB,
          text: 'Contoso synthetic recap for session B.',
          reviewed: true,
        },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test('publishes explicitly redacted step evidence without an AI call and preserves local checkmarks', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await consent(page);
    await page
      .getByRole('checkbox', { name: 'Microphone (You)', exact: true })
      .uncheck();
    await page
      .getByRole('checkbox', {
        name: 'System audio (Meeting; Windows is system-wide)',
        exact: true,
      })
      .uncheck();
    await page
      .getByRole('checkbox', {
        name: 'Watch for meaningful screen changes (review required)',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: 'Start consented session' }).click();
    await expect(page.getByText('Watching', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: '#7 Contoso synthetic firewall test' })
      .click();
    let dialog = page.getByRole('dialog', {
      name: '#7 Contoso synthetic firewall test',
    });
    await dialog
      .getByRole('checkbox', { name: '1. Restrict the synthetic rule.' })
      .check();
    await dialog.getByRole('button', { name: 'Capture step 1' }).click();
    dialog = page.getByRole('dialog', {
      name: 'Capture evidence - review before publishing',
    });
    await expect(dialog.getByText('Watching', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Pause / Private', exact: true }),
    ).toBeEnabled();
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      dialog.getByText('Watching', { exact: true }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole('button', { name: 'Pause / Private', exact: true }),
    ).toBeInViewport();
    await dialog
      .getByRole('button', { name: 'Pause / Private', exact: true })
      .click();
    await expect(
      dialog.getByText('Private / Paused', { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(dialog.getByText('Watching', { exact: true })).toBeVisible();
    const publish = dialog.getByRole('button', {
      name: 'Publish reviewed evidence (no AI)',
    });
    await expect(publish).toBeDisabled();
    await dialog
      .getByRole('button', {
        name: 'Redact entire image (keyboard alternative)',
      })
      .click();
    await dialog
      .getByLabel('Evidence note', { exact: true })
      .fill('Synthetic reviewed walkthrough proof.');
    await dialog
      .getByRole('checkbox', { name: /I reviewed\/redacted the image/ })
      .check();
    await publish.click();
    await expect(
      page
        .getByRole('dialog', { name: '#7 Contoso synthetic firewall test' })
        .getByRole('checkbox', { name: '1. Restrict the synthetic rule.' }),
    ).toBeChecked();
    const calls = await fixture.calls();
    const publication = calls.find(
      (call) => call.channel === 'pronoia:publish-evidence',
    );
    expect(publication?.input).toMatchObject({
      issue: 7,
      step: '1. Restrict the synthetic rule.',
      note: 'Synthetic reviewed walkthrough proof.',
      reviewed: true,
    });
    expect(
      calls.some((call) =>
        ['pronoia:analyse', 'pronoia:ask'].includes(call.channel),
      ),
    ).toBe(false);
    dialog = page.getByRole('dialog', {
      name: '#7 Contoso synthetic firewall test',
    });
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(
      dialog.getByText('Not capturing', { exact: true }),
    ).toBeVisible();
    expect(
      (await fixture.calls())
        .filter((call) => call.channel === 'pronoia:pause')
        .map((call) => call.input),
    ).toEqual([{ paused: true }, { paused: false }]);
    expect(
      (await fixture.calls()).some((call) => call.channel === 'pronoia:stop'),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('keeps all-scope analysis by default and sends the selected finding to reviewed Ask and Analyst', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await consent(page);
    await page
      .getByRole('checkbox', { name: 'Microphone (You)', exact: true })
      .uncheck();
    await page
      .getByRole('checkbox', {
        name: 'System audio (Meeting; Windows is system-wide)',
        exact: true,
      })
      .uncheck();
    await page.getByRole('button', { name: 'Start consented session' }).click();
    await page
      .getByRole('button', { name: 'Analyse screen', exact: true })
      .click();
    let dialog = page.getByRole('dialog', {
      name: 'Review/redact evidence before AI analysis',
    });
    await expect(dialog.getByLabel('AI context')).toHaveValue('0');
    await dialog
      .getByRole('checkbox', { name: /I reviewed the image and excerpt/ })
      .check();
    await dialog
      .getByRole('button', { name: 'Analyse reviewed evidence' })
      .click();
    await expect(dialog).toBeHidden();
    const allScope = (await fixture.calls()).find(
      (call) => call.channel === 'pronoia:analyse',
    );
    expect(allScope?.input).not.toHaveProperty('issue');

    await page
      .getByRole('button', { name: '#7 Contoso synthetic firewall test' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Ask about this finding', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Ask AI - review/redact first' });
    await expect(dialog.getByLabel('AI context')).toHaveValue('7');
    await dialog
      .getByLabel('Question', { exact: true })
      .fill('Explain this synthetic firewall rule.');
    await dialog
      .getByRole('checkbox', { name: /I reviewed the image and excerpt/ })
      .check();
    await dialog
      .getByRole('button', { name: 'Ask with reviewed evidence' })
      .click();
    await expect(
      dialog.getByText('Contoso synthetic answer; no external model call.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await fixture.calls()).find((call) => call.channel === 'pronoia:ask')
        ?.input,
    ).toMatchObject({ issue: 7, reviewed: true });
    await dialog
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();

    await page
      .getByRole('dialog', { name: '#7 Contoso synthetic firewall test' })
      .getByRole('button', { name: 'Analyse this finding', exact: true })
      .click();
    dialog = page.getByRole('dialog', {
      name: 'Review/redact evidence before AI analysis',
    });
    await expect(dialog.getByLabel('AI context')).toHaveValue('7');
    await dialog
      .getByRole('checkbox', { name: /I reviewed the image and excerpt/ })
      .check();
    await dialog
      .getByRole('button', { name: 'Analyse reviewed evidence' })
      .click();
    await expect(dialog).toBeHidden();
    const calls = await fixture.calls();
    expect(
      calls.filter((call) => call.channel === 'pronoia:analyse')[1]?.input,
    ).toMatchObject({ issue: 7, reviewed: true });
    expect(
      calls.some((call) =>
        ['pronoia:post', 'pronoia:manual', 'pronoia:publish-evidence'].includes(
          call.channel,
        ),
      ),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('Stop cancels late microphone permission and resets consent without reactivating capture', async () => {
  const fixture = await syntheticDesktop();
  try {
    const { page } = fixture;
    await page.evaluate(() => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      let grant: (stream: MediaStream) => void = () => undefined;
      const pending = new Promise<MediaStream>((resolve) => {
        grant = resolve;
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => pending,
      });
      (
        window as Window & {
          syntheticPermission?: {
            grant: () => void;
            ended: () => boolean;
            close: () => Promise<void>;
          };
        }
      ).syntheticPermission = {
        grant: () => grant(destination.stream),
        ended: () =>
          destination.stream
            .getTracks()
            .every((track) => track.readyState === 'ended'),
        close: async () => {
          oscillator.stop();
          await context.close();
        },
      };
    });
    await consent(page);
    await page
      .getByRole('checkbox', {
        name: 'System audio (Meeting; Windows is system-wide)',
        exact: true,
      })
      .uncheck();
    await page.getByRole('button', { name: 'Start consented session' }).click();
    await expect(
      page.getByRole('button', { name: 'Stop', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.evaluate(() =>
      (
        window as Window & { syntheticPermission?: { grant: () => void } }
      ).syntheticPermission?.grant(),
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & {
              syntheticPermission?: { ended: () => boolean };
            }
          ).syntheticPermission?.ended(),
        ),
      )
      .toBe(true);
    await expect(
      page.getByText('Not capturing', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start consented session' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('checkbox', { name: /All participants were told/ }),
    ).not.toBeChecked();
    expect(
      (await fixture.calls()).some(
        (call) => call.channel === 'pronoia:activate',
      ),
    ).toBe(false);
    await page.evaluate(() =>
      (
        window as Window & {
          syntheticPermission?: { close: () => Promise<void> };
        }
      ).syntheticPermission?.close(),
    );
  } finally {
    await fixture.close();
  }
});
