# Desktop operation

## Start and package

Use Node 22 and npm from the repository root:

```sh
npm ci
npm run build
npm run desktop
```

`npm run make` creates a portable Windows ZIP under
`apps/desktop/out/make/zip/win32/x64`. Extract it before running Pronoia.
Builds are unsigned: follow your organization's SmartScreen/signing policy;
do not disable device protection.

## Connections

GitHub uses `gh auth token`, or a personal fine-grained token entered in
encrypted Settings. The actor must be a real human. Issue commands require
repository access; publishing evidence/recaps also requires Contents write.
Branch protection can prevent recap publication; it is never bypassed.

Foundry defaults to Entra ID (`az login` locally). Configure an HTTPS Azure
resource/project endpoint and deployment names, not model guesses. Vision
analysis uses the chat deployment; audio needs a transcription deployment.
Realtime additionally needs a compatible realtime transcription deployment.
API-key fallback is an explicit choice. Credential values never return to the
renderer and are encrypted with OS-backed Electron safeStorage; Linux
`basic_text` is rejected.

Environment equivalents are `AZURE_FOUNDRY_ENDPOINT`,
`FOUNDRY_CHAT_DEPLOYMENT`, `FOUNDRY_TRANSCRIBE_DEPLOYMENT`,
`FOUNDRY_REALTIME_TRANSCRIBE_DEPLOYMENT`, `AZURE_AUTH_MODE=identity|key`,
`AZURE_FOUNDRY_API_KEY`, `GITHUB_TOKEN`, `PRONOIA_REPO` and
`PRONOIA_EXPORT_DIR`. Do not commit these values.

`pronoia.config.yml` is Zod-validated and shares the core governance rules.
Set `PRONOIA_CONFIG` to an explicit configuration path in packaged environments.
Settings allow retention, image/rate/token limits and shortcuts to be adjusted.
Use an absolute export folder, such as an approved OneDrive Pronoia folder.

## Session and human review

1. Copy the English/Bahasa meeting-chat notice. Obtain participant notice and
   approval for processing in the configured Foundry region for every session.
2. Choose an assessment, items and capture source. Public boards permit only
   synthetic demonstrations. With both audio sources disabled, evidence capture
   works without a configured model.
3. Batch audio uses complete stopped/restarted 15-second WebM clips. Segments
   retain their capture-start time and identify You versus Meeting. Raw audio
   is never written to disk. Realtime uses verified PCM16 mono at 24 kHz.
4. Capture an image, redact opaque regions or the entire image, and edit/redact
   the excerpt before sending it. Images sent to Foundry have no side longer
   than 1600 pixels; published evidence retains reviewed full-resolution PNGs.
5. Accept/edit/discard proposals individually. Only a human posts a command.
   A verbal validation is data that may prefill a dialog, not approval. Actions
   enforce authorization, evidence and four-eyes independently of the desktop.
6. Use item details for comments, validation history, hash-verified thumbnails
   and per-step remediation evidence. A ticked walkthrough box is local review
   state, not an authoritative assessment result.
7. Stop capture before drafting a Scribe recap. Review/edit it before publishing
   to the configured repository and export folder. Structured verbal decisions
   retain speaker, quote and time as non-authoritative observations. Drafts are
   bound to their originating session and cannot be published under a new one.

Pause/Private and Stop end capture immediately, including pending media
permission requests. A resumed capture gets a new media nonce, so queued audio
from before Pause cannot upload later. Pending model requests retain the
original cancellation signal. Window reload/crash stops the session.

## Recovery, retention and costs

Private drafts/captures live under Electron's user-data Pronoia folder.
Reopening restores a stopped review queue and immutable pending publications;
it never resumes capture or participant consent automatically. Review the
original text/image, including the full outgoing transcript excerpt, before
retrying with the same repository and GitHub actor.
Existing verified evidence, comment receipts and matching recap files are
reused. Edited pending content or conflicting exported files is refused rather
than silently overwritten. Starting another session or changing connections is
refused during publication, including its asynchronous preflight.

Local proposal decisions project to `ai-proposals.csv`; published evidence goes
to `evidence/<issue>/`, and recaps to `sessions/` with `sessions.csv`.
Existing local decisions are preserved. The full M4 export workflow is separate.
Use **Export now** after reviewing the destination and local decision log.
The shared exporter creates `latest` and dated snapshots with six CSVs, published
recaps, SHA-verified evidence and a manifest; it never exports private audio,
capture drafts or unpublished transcript files. A OneDrive destination may sync
automatically, so the confirmation is a real sharing decision.

Retention defaults to 30 days, checked at startup and daily. Raw audio is not
retained at all. Expired private proposal outcomes and Pronoia-owned
crash/temporary snapshots are also purged; unrelated files are not removed.
Published export/report copies need an organization-approved retention policy
of their own. `PRONOIA_USER_DATA_DIR` can select an existing
absolute private folder; tests use isolated synthetic folders.

Budgets reserve concurrent model requests and charge reported usage. When a
provider omits token usage, conservative estimates count instead: batch audio
uses its byte size, realtime commits use 100 token units per source. Warnings
make this explicit. These controls are **not an Azure invoice cap**; use Azure
quotas/cost controls and tune session limits for meeting length. Exhausted
transcription budgets pause capture.

## Known limits

- Windows loopback is system-wide, not limited to the chosen meeting window.
  macOS capture depends on OS/Electron permissions; Linux supports microphone
  only. Teams/protected windows may yield black screenshots or no system audio.
- Realtime reconnect/fallback may lose uncommitted audio; a warning is shown.
  Never infer a test pass from missing audio or protected/black content.
- Pronoia never hides itself from sharing/taskbar. Full-screen evidence may
  include the workstation; select the meeting window when appropriate.
- The verified upstream Electron stable patch is 45.4.1, but the configured
  feed currently lacks it and points `latest` at a prerelease. This build uses
  stable 45.3.1; refresh the approved feed and upgrade before real engagements.
- Live Teams/system audio, a compatible realtime deployment and customer
  approvals require manual environment validation. Live batch/realtime Foundry
  tests passed with generated synthetic speech and Entra ID, without microphone
  or speaker output. This does not establish physical meeting/system-audio readiness.
