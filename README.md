# Pronoia

A transparent assessment co-pilot: AI proposes, humans decide. GitHub Issues are
the authoritative assessment board and comment commands provide the audit trail.

## Implementation status

M0–M3 provide the governed board, recoverable comment commands, validated native
alerts/SARIF, cached enrichment and SLAs, direct Foundry role/audio adapters and
reviewable AI/Copilot integrations. Live Foundry credentials/deployments are
configured separately. The desktop and reporting/agent interfaces are described
below. Power BI and the final verified release remain later milestones.

| Milestone | Deliverable                                                   |
| --------- | ------------------------------------------------------------- |
| M0        | Workspaces, quality tools, CI, repository and agent safety    |
| M1        | Governed board, comment commands, guards and CLI              |
| M2        | Security alerts, SARIF, prioritisation and Foundry triage     |
| M3        | Consented Electron co-pilot, presenter view and evidence      |
| M4        | Audited exports, Cowork, MCP, Scout and optional integrations |
| M5        | Synthetic data and Power BI semantic model/report             |
| M6        | Setup, runbook, privacy documentation and verified release    |

## Development

Use Node.js 22.17 or later (Node 22 is exercised in CI) and npm. GitHub
authentication uses `gh auth login`; never paste a token into source code.

```sh
npm install
npm run lint && npm run typecheck && npm test
npm run build
```

Tests and builds are mandatory. Core coverage requires at least 80% lines,
statements, functions and branches.

## Board quick start

```sh
npm run build
npm run pronoia -- setup
npm run pronoia -- import assessments/security-readiness.csv --assessment "Security Readiness - Contoso" --synthetic
```

Repeat the import to verify idempotence. Preview without credentials or GitHub
writes using `npm run demo:seed -- --dry-run`. Other templates cover firewall,
code-vulnerability and migration-readiness assessments.

Post `/start`, then `/validate <what was tested>`. A different, uninvolved human
posts `/approve` after reviewing evidence; `/reject <reason>` sends the item
back to In Progress. GitHub Actions are authoritative, and manual closures or
status edits are repaired by the guard. Approval from To Do, missing reasons,
bot approvals and self approvals are refused with an explanation.

Publish only reviewed synthetic images to this public repo:

```sh
npm run pronoia -- evidence add --issue 1 --file shot.png --note "Synthetic demo evidence" --reviewed --synthetic
npm run pronoia -- comment --issue 1 --body "/validate verified in the demo"
```

Agents add `--agent scout` or set `PRONOIA_AGENT_NAME`. Human-only commands are
refused even when the agent uses a human token. Collaborators may post
`/ai triage|remediate|test-plan|summarize` for a labelled, non-authoritative
proposal. `/copilot` requires a separate, supported user `PRONOIA_AGENT_TOKEN`;
it preserves assignees and records a recoverable assignment receipt.

## Security and AI

`sync-security.yml` discovers all configured targets daily and explicitly
dispatches the same per-issue command authority. The weekly/manual scanner reads
target sources and the intentionally vulnerable synthetic sample without
executing either. Merged same-repository PR references request **Validate, never
Done**. Separate target READ/optional-dismiss credentials never write statuses.

Offline previews need no credentials or network:

```sh
npm run pronoia -- sync-security --fixtures samples/security --dry-run --synthetic
npm run pronoia -- ingest-sarif samples/security/sarif.json --dry-run --synthetic
```

See [security and AI integration](docs/security-and-ai.md) for workflows, token
permissions, exact dismissal enums, privacy/expiry behavior and the public
main-process Foundry API. The [vulnerable fixture](samples/vuln-app/README.md) must
never be deployed or run in a shared environment.

## Desktop co-pilot

```sh
npm ci
npm run build
npm run desktop
```

`npm run make` produces an unsigned portable ZIP. In encrypted Settings, configure
the Foundry endpoint and your vision/transcription deployments, or use screen-only
evidence without audio. Copy the meeting notice, obtain participant and cloud
consent, select the assessment/items/source, then start. Pause/Stop remain visible
in review dialogs; AI never signs off.

The English/Bahasa UI includes presenter/compact views, live captions, proposals,
in-app evidence and audit trails, per-step remediation evidence and human dispute
dialogs. Publication retries restore stopped, reviewed work rather than recapture.
See [desktop operation and limits](docs/desktop.md).

## Reporting and safe agents

```powershell
node .\packages\cli\dist\index.js board-list --status validate
node .\packages\cli\dist\index.js item-get --issue 1
node .\packages\cli\dist\index.js export --out "<approved-folder>"
```

Desktop **Export now** requires explicit human review. The shared exporter
reconstructs audit state/history, verifies PNG hashes and writes six CSVs,
referenced evidence/recaps and a checksummed manifest into `latest` and a dated
snapshot. Local accepted/edited/discarded AI decision rows are preserved; private
audio, draft captures and unpublished transcript files are not collected.

[Cowork handoff](docs/cowork/README.md) contains weekly Word/Excel/email-draft
and meeting prompts, OneDrive paths and Task Scheduler instructions. Every send,
including a no-change note, waits for a real human.

The built stdio MCP server exposes seven safe tools. Use the checked-in VS Code
configuration or [Scout configuration and limits](docs/scout.md); build first.
Agents always carry their own marker and cannot approve, reject, dispute,
confirm or close issues. MCP tool approval does not bypass GitHub governance.
Tenant permissions, Projects, Teams and SharePoint remain explicit optional
configuration; file creation alone does not establish live integration readiness.

## Safety

- Only synthetic Contoso, Fabrikam and Northwind data belongs in this public repo.
- Real screenshots/transcripts require a private, customer-approved repository.
- AI and agents must never approve, reject, dispute or close an issue.
- Foundry uses Microsoft Entra ID first; an API key is only a fallback.
- Capture is visible and requires participant notice and explicit consent.
- No code is copied from OpenCluely; only transparent UX ideas are considered.

See [AGENTS.md](AGENTS.md) for the shared contract and
[decisions](docs/decisions.md) for implementation defaults.
