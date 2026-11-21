# Implementation decisions

## ADR 001: Latest supplied specification is authoritative

- Status: accepted, 2026-11-20.
- Decision: use the expanded TypeScript/workspaces specification, not the earlier
  plain-JavaScript dependency restriction.
- Reason: the user explicitly requested execution of the replacement attachment.

## ADR 002: Compatible stable development tools

- Status: accepted, 2026-11-20.
- Decision: exercise Node 22 in CI, with TypeScript 5.9, ESLint 9 and Vitest 4.
  Pin Actions to the verified full SHA of the official v4 releases.
- Reason: the npm registry's current TypeScript-ESLint `latest` tag is a
  prerelease; use a compatible stable toolchain rather than mixing prereleases.
- Dependencies: ESLint, its TypeScript/Prettier integrations, TypeScript, Node
  types, Vitest and its V8 coverage provider are development-only tools required
  by the supplied quality gates. Prettier is the requested formatter.

## ADR 003: Empty-repository bootstrap

- Status: accepted, 2026-11-20.
- Decision: clone the empty remote into the empty supplied workspace and use
  `main`, as explicitly requested. Configure Git identity locally using the
  authenticated GitHub login and its GitHub noreply address.
- Reason: there is no existing commit/worktree to isolate and no existing
  user content to overwrite; global Git configuration is not changed.

## ADR 004: No artificial application test at M0

- Status: accepted, 2026-11-20.
- Decision: M0 tests permit an empty suite; there are no production functions
  yet. M1 removes that exception, adds behavior tests and a real build target.
- Reason: a test of a constant would manufacture evidence rather than validate
  application behavior. Scaffold completion is not application completion.

## ADR 005: Recoverable command journal

- Status: accepted, 2026-11-20.
- Decision: write the trusted transition audit before applying labels and
  closing/reopening. A retry first reconciles the last journaled state.
  Process every unaudited command comment, not only the event that triggered
  the job.
- Reason: GitHub Actions per-issue concurrency retains only one pending job;
  processing the comment queue avoids lost commands. Audit/rejection replies
  never begin with `/`, so they cannot become commands on replay.

## ADR 006: Public demonstrations require explicit attestation

- Status: accepted, 2026-11-20.
- Decision: CSV import into a public board requires `--synthetic`. Evidence
  also requires `--reviewed` and `--synthetic`. Identical PNGs in the same
  second reuse the committed file; conflicting content is not overwritten.
  Approval verifies the PNG and SHA-256 against its evidence comment.
- Reason: a file extension or a claim in an issue body is not evidence of
  a safe, unchanged screenshot. Real engagements require a private repo.

## ADR 007: Assessment run identity

- Status: accepted, 2026-11-20.
- Decision: assessment names use ASCII slugs for labels/dedupe keys. Use the
  assessment name as the default milestone; `--milestone` names a specific run.
  A risk acceptance requires a future date, not an indefinite exception.
- Reason: stable dedupe makes repeated imports safe while each assessment
  retains a run milestone and explicit exception expiry.

## ADR 008: Mandatory approval policy and trusted writer

- Status: accepted, 2026-11-20; explicitly confirmed by the user.
- Decision: configuration cannot disable four-eyes or global evidence checks,
  or allow self approval. A test may explicitly declare `evidence_required:
false`. Only `github-actions[bot]` may author authoritative audit/result
  markers; configured automation logins remain restricted command actors.
- Reason: scanner and agent identities must not gain the ability to forge
  approvals by being classified as automation.

## ADR 009: Request and evidence integrity

- Status: accepted, 2026-11-20.
- Decision: GitHub fetches get fresh 15-second abort deadlines; the installed
  Octokit request layer does not implement a `timeout` option. Use the current
  documented REST API version `2026-03-10`. PNG checks use Node's CRC32 and
  bounded zlib inflation with chunk and scanline validation.
- Reason: timeout-shaped configuration and PNG-shaped byte markers alone do
  not establish working deadlines or valid image payloads.

## ADR 010: Direct model SDK and compatible patched tests

- Status: implemented, 2026-11-20; live endpoint configuration is separate.
- Decision: pin OpenAI 7.56.0 for the direct v1 Responses/audio APIs,
  `@azure/identity` 4.14.1 for refreshable Entra authentication, and ws 8.23.0
  for the SDK's main-process realtime peer. `@types/ws` is development-only.
  SDKs load on use so normal board commands retain their lightweight startup.
- Reason: no hosted Foundry Agents, provisioning layer or replacement runtime
  is needed. These are the explicitly requested runtime dependencies.
- Test tooling: replace scaffold Vitest/coverage 4.0.18 with compatible stable
  5.1.0, whose Node engines accept the existing Node 22 runtime. Existing tests
  and all four 80% core coverage thresholds remain intact.

## ADR 011: Shared authority for asynchronous source work

- Status: implemented, 2026-11-20.
- Decision: discovery creates initial To Do issues and queues validated SARIF
  snapshots, never changing existing statuses. Explicit `workflow_dispatch`
  routes security/merge work to the reusable commands workflow, sharing the
  same numeric issue lock with human comments and AI. Every worker also checks
  current source work after draining comments, so replacement pending jobs do
  not discard scanner intent.
- Reason: ordinary GITHUB_TOKEN comments do not retrigger Actions; explicit
  dispatch does. Trusted internal restricted bot commands need association NONE
  support, without changing external ACLs or audit trust.
- Recovery: transition journal first, idempotent proposal/assignment receipts,
  persisted assignees, then reconciliation/reaction and completion. Source
  observations and merge receipts never replace live PR/alert verification.

## ADR 012: Desktop privacy takes precedence over unattended image uploads

- Status: accepted implementation default, 2026-11-20.
- Decision: a capture hotkey or meaningful auto-watch change queues a local
  screenshot for review. A human paints opaque redactions, edits the transcript
  excerpt and explicitly sends it to Foundry. Auto-watch never silently uploads
  changing screen content. Pronoia windows remain visible during capture.
- Reason: mandatory transparency, consent and pre-upload redaction override
  the competing request to hide the overlay briefly or analyse every changed
  frame without per-frame review. Choose the meeting window instead of the
  entire screen to avoid recursive overlay content.

## ADR 013: Forge 8 template and Windows packaging

- Status: accepted implementation default, 2026-11-20.
- Decision: Forge 8 uses `--template vite --typescript`; the old combined
  template name was rejected by the installed CLI. Keep the requested React,
  Fluent UI, ESLint/Prettier and Vitest stack, removing unused generated Linux
  installers, Squirrel startup and Oxlint/Oxfmt configuration. Portable ZIPs
  are unsigned. Package directly to output (`tmpdir: false`) because the final
  temporary-directory rename failed on this Windows profile path.
- Reason: these are platform/tool compatibility changes, not additional app
  features. The real Electron consent smoke test now launches successfully.

## ADR 014: Latest accessible stable Electron

- Status: environment limitation, 2026-11-20.
- Decision: use stable Electron 45.3.1, the latest stable package available in
  the configured npm feed. Upstream GitHub reports 45.4.1, but the feed returns
  404 for it and direct/alternative npm registries fail TLS. Do not silently
  mix one npm version with a different downloaded runtime binary.
- Risk: refresh the approved package feed and upgrade to the upstream stable
  patch before a production engagement.
- Rechecked 2026-11-21: GitHub's stable release remains 45.4.1 and the feed
  still returns 404 for that version. Its `latest` tag points to 46.0.0-alpha.10;
  do not substitute that prerelease for the verified stable build.

## ADR 015: Explicit Electron test environment

- Status: accepted, 2026-11-20.
- Decision: remove `ELECTRON_RUN_AS_NODE` entirely from smoke-test environments
  and normalize the Windows application path before launching Playwright.
- Reason: an empty-but-present variable still selected Node mode; a trailing
  directory separator caused a failed launch. Tests must verify the real
  consent UI, not merely a successful process start.

## ADR 016: Capture cancellation and bounded realtime readiness

- Status: accepted, 2026-11-20.
- Decision: propagate cancellation through asynchronous media permissions and
  AudioWorklet setup. Late-acquired tracks are stopped and never uploaded.
  Buffer PCM16 in memory until transcription configuration is acknowledged;
  each source is limited to 2 MiB and failed sends remain queued for retry.
  Reconnect/fallback warns that uncommitted audio may be missing. No audio
  buffer is written to disk.
- Privacy: camera access is denied; permission checks and requests both require
  the consented main frame. Proposal previews use the reviewed/redacted image,
  never its original capture. Auto-watch compares small frames before retaining
  a full-resolution capture and never replaces an open human review.
- Accessibility: use Fluent UI's focus-trapped dialogs with Escape/return-focus
  behavior, and offer a keyboard-accessible full-image redaction action.

## ADR 017: Durable reviewed publication and capture generations

- Status: accepted, 2026-11-21.
- Decision: journal immutable human-reviewed intent locally before publishing.
  Retry against the same repository/actor and existing comment/file receipts,
  preserving capture time and hashes. Interrupted proposal outcomes remain
  recoverable; CSV projection never replaces other local outcomes.
- Privacy: reopening restores stopped review work, never capture or consent.
  A new media nonce on Pause/resume/Stop rejects stale queued audio. Model and
  screenshot operations retain their original cancellation signal. Changing
  settings archives the previous session and requires fresh consent.
- The display video grant stays alive for system loopback, but only audio
  tracks enter MediaRecorder. Stop ends every track. Rate is verified at 24 kHz
  before realtime PCM starts; recorder/device errors stop capture explicitly.
- Shared core configuration retains the mandatory governance policy. YAML is
  already part of the approved stack; the desktop declares it directly because
  the packaged application must read configuration without depending on the CLI.
- Token reservations and reported usage bound new requests. Unknown batch
  usage uses byte-based estimates; realtime commits use 100 estimated token
  units per source. These controls are not a hard cloud invoice cap.

## ADR 018: Standalone packaged model dependencies

- Status: accepted, 2026-11-21.
- Decision: preserve the ordinary npm workspace layout. Statically supply the
  approved SDK constructor/token provider from the desktop to the shared client
  factory, while CLI SDK loading remains lazy. Rolldown's Node platform provides
  native CommonJS builtin resolution in ESM output; Forge packages Vite output
  only. Native File supplies finalized audio uploads without a dynamic SDK require.
- A small synchronous CJS bootstrap initializes userData/sessionData and the
  single-instance lock before asynchronously loading the SDK-bearing ESM module.
- Reason: the initial hoisted ASAR omitted lazy SDK dependencies. A nested
  installation experiment exhausted the host heap and was abandoned, not shipped.
  Static bundling plus Node-platform output passed an actual copied executable
  test outside the workspace, with capture denied before consent.

## ADR 019: Verified Azure batch-audio protocol

- Status: accepted, 2026-11-21.
- Decision: keep Responses and realtime on v1. Batch transcription uses the
  documented deployment-scoped `2024-10-21` audio API, with the same Entra client
  or explicit Azure `api-key` header. Unsupported v1 audio returned
  DeploymentNotFound despite a successful deployment; no output was trusted.
- Evidence: synthetic speech generated without a microphone/speaker, encoded by
  the actual Electron MediaRecorder, transcribed by a live Entra-authenticated
  deployment. Batch and PCM24k realtime both recognized all eight expected
  vocabulary terms. Other model deployments and assessment statuses were unchanged.

## ADR 020: Safe MCP through the shared CLI

- Status: accepted, 2026-11-21.
- Decision: use the specification's MIT MCP SDK 1.32.2 rather than silently
  substituting the split v2 packages shown in current tutorials. The stdio server
  forwards strict validated arguments through the shared CLI without a shell.
  Agent identity is mandatory for write paths; human-only commands are refused
  before execution. No stdout logging is mixed with JSON-RPC.
- Reason: reuse workflow authorization and the audited GitHub command path
  instead of creating a second status engine. Configuration contains no tokens.

## ADR 021: Exact replay exports and managed snapshots

- Status: accepted, 2026-11-21.
- Decision: share six CSV contracts and a versioned manifest. Rebuild state and
  history from trusted Actions audits, verify referenced PNG bytes and hashes,
  preserve published recaps and local reviewed decision outcomes. Accepted/edited
  proposals publish a redacted data marker, never an authority marker.
- Managed `latest` and dated output directories are staged before replacement;
  unknown directories, links, changed files and escaping paths are refused.
  Git publication uses the exports branch without force and preserves prior
  dated snapshots. The manifest excludes its own recursive checksum.
- Privacy: no raw audio, private capture files or unpublished transcript files
  are collected. Cloud jobs cannot infer private discarded outcomes; local
  logs are explicitly supplied/confirmed by the human operator.

## ADR 022: Every Cowork send requires a human

- Status: accepted, 2026-11-21.
- Decision: the weekly prompt creates Word/Excel/email drafts and a no-change
  note, but sends neither automatically. The specification's no-change
  "send only me" line is interpreted as a draft awaiting approval because the
  stronger human-only sending rule applies to every message.
- Meeting statements remain observations. Scheduling, tenant permissions,
  approved storage and the actual sending approval are manual configuration,
  not capabilities claimed merely because prompt files exist.
