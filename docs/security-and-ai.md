# M2 security and AI integration

## Authority and privacy

Only Actions `GITHUB_TOKEN` writes board statuses. Commands occupy the first
comment line; discovery/import only creates initial To Do items. All issue
workers use `issue-<canonical numeric issue>` concurrency, drain pending comments
and recover incomplete journals **before** overlaying live fields. Sync, merge,
ordinary comments and AI use the reusable `commands.yml` worker.

Normal token-created comments do not retrigger Actions. Discovery explicitly
dispatches `commands.yml` on `main` (the documented workflow_dispatch exception).
Workers also process the latest native alert/SARIF observation, including when
an older pending dispatch is replaced by an ordinary command job.

Merge discovery and manual-AI discovery persist trusted issue-level intents
before dispatch. Every surviving issue worker consumes unfinished intents
regardless of its requested mode; receipts make effects/completion retries
idempotent. Manual-AI requester identity is captured from the original
authenticated event and rechecked through GitHub, never substituted by the
event that happens to run the surviving worker.

Native discovery and SARIF ingestion share `security-discovery` with GitHub's
documented [`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): creation remains serialized without replacing pending
ingestion jobs (GitHub supports up to 100 pending runs). actionlint 1.7.12 does
not yet recognize this new key; CI filters only that exact syntax diagnostic
and separately tests the exact queue value, shared group and non-cancellation.

Internal `github-actions[bot]` may process its own restricted start/validate/
block/reopen commands with association NONE. This does **not** authorize external
bots, agent-marked human tokens or configured automation logins to bypass ACLs.
Only the actual Actions bot's audit/result/observation markers are trusted.

Public boards reject private targets and real/unattested engagements. Own public
repository code is the default synthetic dogfood target. Other public targets
require `synthetic: true` in their target configuration or explicit attestation.
SARIF publication always requires attestation. All sample data is fictional;
secret values, source snippets and machine paths are omitted/redacted. An explicit
scanner checkout root may relativize paths inside it, never outside it.

## Sources, enrichment and deadlines

OSV uses `--no-ignore` for the nested, source-only checkout: OSV's documented
repository-boundary limitation otherwise applies the board's `.pronoia-scan`
ignore rule to the target and incorrectly reports no package sources. Target
code is still never installed, built or executed.
SARIF artifact index `-1` is the standard absence sentinel (and is emitted by
OSV); lower values are rejected. An explicit URI remains subject to path
redaction and the configured scanner-root boundary.

Dependabot, code scanning and secret scanning are Zod-validated. Secret scanning
requests use `hide_secret=true`; neither literal secrets nor secret locations are
retained. Dedupe keys are `<source>/<lowercase owner>/<repo>/<alert number>`.
SARIF requires 2.1.0 and uses rule + relative path + hashed fingerprints.
Without a supplied fingerprint, the stable fallback includes the reported line;
line-moving tools should supply fingerprints. Sanitized SARIF roundtrips preserve
the key and omit original messages, help/snippets and absolute paths.

GitHub `GET /advisories/{ghsa_id}`, batched FIRST EPSS and CISA KEV use a validated
24-hour JSON cache in `.pronoia-cache` (also restored in Actions). EPSS queries
stay within 2000 characters and retain score, percentile and date. Missing or
unavailable values remain null with explicit warnings, never inferred zeroes.
Advisory `cve_id`/CVE identifiers are resolved before EPSS/KEV batching, including
GHSA-only findings; resolved aliases are retained in finding metadata.
Optional `PRONOIA_NVD_ENABLED=true` enables NVD API 2 fallback; calls are spaced
6500 ms without a key or 650 ms with `NVD_API_KEY`. No `audit fix --force` is used.

Priority defaults:

| Priority | Condition                                   | SLA     |
| -------- | ------------------------------------------- | ------- |
| P1       | KEV, CVSS ≥9, or EPSS ≥.5 **and** CVSS ≥7   | 7 days  |
| P2       | CVSS ≥7 or EPSS ≥.1                         | 14 days |
| P3       | CVSS ≥4                                     | 30 days |
| P4       | Otherwise, with warnings for missing inputs | 90 days |

Thresholds and days are configurable. Due dates stay anchored to first-seen/
source-created **WIB** day, not today's sync. A human `/due` override is retained.
`priority:*`, `kev`, `due_date` metadata and `sla:breached` reflect this policy;
completed items are checked against their actual approval date, not every later
day. Human severity overrides are retained; otherwise source severity refreshes.

Fixed/dismissed source alerts request Validate with an observed-state receipt;
dismissed is **not** fixed proof. Done findings reappearing after a real source
state change reopen. A still-open risk acceptance is not immediately reopened
with `auto_dismiss=false`. `until` is inclusive in WIB: expiry reopens on the next
WIB day. Approval still requires a different uninvolved human and evidence, or
a real merged PR plus live verification that **all** linked native alerts are
fixed. User-made proof markers and incomplete/malformed PR responses cannot
satisfy that bypass. SARIF snapshots cannot supply a native fixed-alert bypass.
Automated-source metadata cannot waive evidence, even if a prior journal contains
a stale `evidence_required=false`; the explicitly approved checklist waiver remains.

## Tokens and optional dismissal

| Credential                                             | Purpose / permissions                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions `GITHUB_TOKEN`                                 | Authoritative board issue writes; least per-job read permissions; discovery additionally dispatches workflows                                              |
| `PRONOIA_TARGET_TOKEN`                                 | Separate target READ PAT/App: metadata, contents for scanning, Dependabot/vulnerability alerts, security events/code scanning, secret-scanning alerts read |
| `PRONOIA_READ_APP_ID` + `PRONOIA_READ_APP_PRIVATE_KEY` | Optional SHA-pinned READ App token action; use an installation covering the configured owner, or a user/PAT credential covering all targets                |
| `PRONOIA_DISMISS_TOKEN`                                | Separate optional target alert write credential, used only when `auto_dismiss=true` and the trusted journal records human-approved dispute                 |
| `PRONOIA_AGENT_TOKEN`                                  | Copilot **user-to-server**, not installation token: metadata R and actions/contents/issues/PR RW; classic PAT requires repo scope                          |

For own public-repository reads only, a worker may use its board token's read
permissions if no separate READ credential is configured. External and own-private
target reads/checkout never fall back to the board token; missing READ credentials
warn and skip before any target request. 403/404 scanner
responses log and skip; other failures are explicit. Target and Copilot
credentials never receive a board status-write path.

Requested READ aliases are supported: `PRONOIA_SCAN_TOKEN` aliases
`PRONOIA_TARGET_TOKEN`; workflow variable or secret `PRONOIA_APP_ID` and secret
`PRONOIA_APP_PRIVATE_KEY` alias the corresponding `PRONOIA_READ_APP_*` names.
App IDs may be variables or secrets; normalization through `env` keeps secret
references out of unsupported step conditions. Current names take precedence.
These aliases never select a board-writer or
DISMISS credential. Metadata `repos.get` 403/404 also warns/skips per target,
including the own sample, while privacy/schema faults remain strict.

Copilot 401/403/404/422 failures complete as audited no-ops with a typed receipt
and retained pre-command state, so later commands and retries are not stuck.
Confirmed assignments can recover even if the user token is subsequently removed.
HTTP-200 responses without the requested Copilot assignee are also terminal
nonconfirmation, not success. Trusted AI proposal receipts likewise recover
without Foundry configuration and without generating a second proposal.

Auto-dismiss defaults to false. An audited human approval, matching dispute type,
requester, reason and validation timestamp is required. Exact source reason
mapping (the board dispute reason remains in its audit):

| Approved dispute | Dependabot `dismissed_reason` | Code scanning `dismissed_reason` | Secret scanning `resolution` |
| ---------------- | ----------------------------- | -------------------------------- | ---------------------------- |
| false-positive   | `inaccurate`                  | `false positive`                 | `false_positive`             |
| not-applicable   | `not_used`                    | `won't fix`                      | `wont_fix`                   |
| risk-accepted    | `tolerable_risk`              | `won't fix`                      | `wont_fix`                   |

Dependabot/code scanning use `state=dismissed`; secret scanning uses
`state=resolved`. Not-applicable is not falsely described as “used in tests.”
Dismissal receipts include approval command/audit IDs. Expiry reopens the board;
it does not claim a dismissed alert was remediated or automatically approve it.

## Workflows and CLI

- `sync-security.yml`: daily `0 23 * * *` UTC (06:00 WIB), plus manual.
- `scan.yml`: Sunday `0 22 * * 0` UTC (Monday 05:00 WIB), plus manual.
  OSV-Scanner 2.7.1 is checksum-verified; it scans source/lockfiles only, with Go
  call analysis disabled. No target/sample install, build or server is executed.
  Sanitized SARIF ingestion is primary; own-repo code-scanning upload is optional
  and continue-on-error. Artifacts retain only sanitized metadata for one day.
  The mandatory own sample carries `sample: true` in its plan/bundle and requires
  explicit synthetic attestation, the fixed sample assessment, and only
  `samples/vuln-app/` finding paths. This is the only unconfigured-repo exemption;
  public/private protections still apply.
- `verify-on-merge.yml`: actual merged, same-repository PRs with Refs/Fixes/Closes
  references dispatch Validate, never Done; open Validate items also receive a
  deduplicated real merge receipt.
- `ai.yml`: collaborator `/ai` or manual item triage, using the same issue worker.
  Manual requester identity comes from the actual Actions event and GitHub's
  collaborator/profile APIs, never a CLI actor argument.
- Weekly Dependabot covers root npm, the sample npm directory and GitHub Actions.
  Existing CodeQL default setup dogfoods this public repository; do not enable a
  conflicting advanced setup. Optional Semgrep CE fallback must use reviewed
  local rules and sanitized SARIF: its engine is LGPL-2.1, while the upstream
  rules catalog uses the separate Semgrep Rules License. Neither is vendored here.

All third-party actions are SHA-pinned. Scanner/command jobs install exactly:

```sh
npm ci -w @pronoia/core -w @pronoia/cli --include-workspace-root
npm run build -w @pronoia/core && npm run build -w @pronoia/cli
```

This excludes future desktop/Electron downloads. Dispatch/scanner success and
the <60-second command goal require live Actions verification, not unit mocks.

Offline:

```sh
npm run pronoia -- sync-security --fixtures samples/security --dry-run --synthetic
npm run pronoia -- ingest-sarif samples/security/sarif.json --dry-run --synthetic
```

Actions-only: `sync-security --discover --dispatch`, `ingest-sarif <file>
--synthetic --dispatch` (or `--bundle`), `verify-on-merge --pull <n> --discover
--dispatch`, `process-issue --issue <n> --mode commands|sync|merge`, and
`ai --issue <n>` for an authenticated workflow_dispatch requester.

## Public Foundry API — Node/main process only

Live v1 verification uses Entra ID and synthetic text only. Foundry rejects the
JSON Schema `uri` format, so the wire-schema generator removes that annotation;
the original Zod schema still validates HTTPS URLs locally. Invalid references
remain invalid outputs, not trusted citations. The SDK cold-start test hook has
a bounded 30-second allowance on this shared Windows machine.

Exports from `@pronoia/core`:

```ts
foundryConfig(env?: Record<string, string | undefined>): AiResult<FoundryConfig>
createFoundryClient(
  config: FoundryConfig,
  options?: { fetch?: typeof fetch; tokenProvider?: () => Promise<string> },
): OpenAI
new FoundryService(client: OpenAI, config: FoundryConfig)

service.call<R extends Role>(
  role: R, input: RoleInput, context: RoleContext, signal?: AbortSignal,
): Promise<AiResult<RoleOutput<R>>>
service.transcribe(
  bytes: Uint8Array, language?: string, signal?: AbortSignal,
): Promise<AiResult<TranscriptionOutput>>
service.openRealtime(
  onError?: (error: AiError) => void, signal?: AbortSignal,
): Promise<AiResult<RealtimeHandle>>
```

`Role` is Intake/Triage/Listener/Analyst/Coach/Verifier/Scribe. Public schemas/types:
`roleSchemas`, `analystSchema`, `verbalDecisionSchema`, `AnalystOutput`,
`RoleOutput<R>`, `RoleInput`, `RoleContext`, `FoundryConfig`,
`foundryConfigSchema`, `azureEndpointSchema`, `AiError`, `AiResult<T>`,
`TokenUsage`, `TranscriptionOutput`, `RealtimeHandle`.

- `RoleInput`: `{text, image_data_url?, image_reviewed?: true}`. Images must be
  reviewed PNG/JPEG/WebP base64 data URLs, never arbitrary fetched URLs.
- `RoleContext`: `{config: Config, issues: {number, state: WorkflowState}[],
references?: string[], at?: string}`. Unknown issues fail validation; illegal
  proposals become none + warning. Legality is checked for a potential human
  reviewer only; no hypothetical actor is persisted or executes a command.
  All outbound context strings, including issue-state prose and reference URLs,
  are redacted before transport without a stringify/reparse redaction step.
  State types/governance are validated, and legality/reference checks still use
  the original validated context.
- Exact Analyst fields: `issue: number|null`, `observed`, `result:
pass|fail|unclear|n/a`, `proposed_command: /start|/validate|/block|/confirm|none`,
  `reason`, `remediation: string[]` (max 7), `evidence_note`,
  `verbal_decision: {type: approve|reject|dispute|none, speaker, quote, at}`,
  `confidence: 0..1`. Approve/reject/dispute command outputs are impossible.
- Coach returns answer + allowlisted references; Scribe returns a recap,
  verbal decisions/follow-ups and mandatory `requires_human_review: true`.
  No recap-sharing side effect is provided.
- `AiResult` discriminates `ok`; success has `value`, failure has safe typed
  `error`. Both include nullable token usage and warnings. Usage includes
  input/output/total tokens and logical calls, including structured repair.
  Missing usage is not fabricated.
- Caller signals cancel pending role/audio/realtime work, including credential
  waits, with `error.code='cancelled'` and no repair retry or raw abort reason.
  Role/audio operations have a combined 45-second deadline; realtime credential/
  handshake work has 15 seconds. Stop/Private also closes the realtime socket.
- Batch transcription uploads the **whole finalized WebM file** using
  native `File`, max 25 MiB, optional ISO-639-1 language. Do not
  pass arbitrary byte fragments/PCM or infer container completeness from a
  chunk boundary. A fixed security-vocabulary prompt covers MFA, Entra ID, CVE,
  CVSS, EPSS, KEV, SARIF and related terms without inventing speech. No audio is
  persisted. Azure batch audio uses the documented deployment-scoped endpoint
  `/openai/deployments/<deployment>/audio/transcriptions?api-version=2024-10-21`.
  The v1 audio route returned DeploymentNotFound during real synthetic testing;
  the documented route passed with Entra ID. Explicit key mode uses `api-key`,
  not a bearer key. No failure is silently treated as a transcript.
- Realtime handle: `{connection: OpenAIRealtimeWS, transcription_model: string}`.
  The factory resolves auth and returns a connecting Node socket; wait for
  socket open, configure the transcription session using that deployment and
  close it on capture stop. Handshake timeout is 15 seconds, max payload 1 MiB,
  compression off; errors delivered to the callback are sanitized.

Endpoint must be HTTPS on an Azure OpenAI/Cognitive Services resource, or
`https://<resource>.services.ai.azure.com/api/projects/<project>`. The base URL is
endpoint trimmed of trailing slashes + `/openai/v1/` for Responses/realtime;
batch audio is the documented deployment-scoped exception above.
`FOUNDRY_CHAT_DEPLOYMENT`, `FOUNDRY_TRANSCRIBE_DEPLOYMENT` and
`FOUNDRY_REALTIME_TRANSCRIBE_DEPLOYMENT` are deployment names, never catalog IDs.
Authentication defaults to managed identity even if a fallback API key exists:
`getBearerTokenProvider(DefaultAzureCredential, 'https://ai.azure.com/.default')`.
`AZURE_AUTH_MODE=key` explicitly selects the optional supplied
`AZURE_FOUNDRY_API_KEY`; `identity` or an unset/empty mode retains identity.
Never serialize config/client/token/socket objects to a renderer or log prompts,
raw output or credentials. All role JSON uses one validation/repair mechanism,
one structured repair then typed failure, 1600 output tokens and explicit
15-second request timeout/one transport retry.

In Actions, provide existing user-assigned identity `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` variables with the appropriate GitHub
OIDC federation, and Cognitive Services OpenAI User on the existing resource.
No app registration, identity provisioning, model deployment or secret retrieval
is implemented. Optional API-key fallback uses `AZURE_AUTH_MODE=key`; no key
reaches a renderer. Live endpoint, audio/realtime and Actions runs are separate
verification work, not assertions made by the fixture suite.
