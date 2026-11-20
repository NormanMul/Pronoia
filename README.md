# Pronoia

A transparent assessment co-pilot: AI proposes, humans decide. GitHub Issues are
the authoritative assessment board and comment commands provide the audit trail.

## Implementation status

The workspaces, governed board engine, CLI, comment workflow and behavior tests
are implemented. Desktop, scanning and reporting features follow in the remaining
milestones. Audio capture is not part of the board milestone.

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
refused even when the agent uses a human token. `/ai` and `/copilot` require the
security/Foundry milestone and are not enabled by the board scaffold alone.

## Safety

- Only synthetic Contoso, Fabrikam and Northwind data belongs in this public repo.
- Real screenshots/transcripts require a private, customer-approved repository.
- AI and agents must never approve, reject, dispute or close an issue.
- Foundry uses Microsoft Entra ID first; an API key is only a fallback.
- Capture is visible and requires participant notice and explicit consent.
- No code is copied from OpenCluely; only transparent UX ideas are considered.

See [AGENTS.md](AGENTS.md) for the shared contract and
[decisions](docs/decisions.md) for implementation defaults.
