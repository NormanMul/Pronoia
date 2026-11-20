# Pronoia

A transparent assessment co-pilot: AI proposes, humans decide. GitHub Issues are
the authoritative assessment board and comment commands provide the audit trail.

## Implementation status

M0 establishes the npm workspaces, strict TypeScript, formatting, linting, tests
and SHA-pinned CI. Application features are implemented in the following
milestones; the scaffold alone does not capture audio or change assessment items.

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

M0 intentionally has no application tests or application build targets. Both
become mandatory when the workflow engine is implemented in M1.

## Safety

- Only synthetic Contoso, Fabrikam and Northwind data belongs in this public repo.
- Real screenshots/transcripts require a private, customer-approved repository.
- AI and agents must never approve, reject, dispute or close an issue.
- Foundry uses Microsoft Entra ID first; an API key is only a fallback.
- Capture is visible and requires participant notice and explicit consent.
- No code is copied from OpenCluely; only transparent UX ideas are considered.

See [AGENTS.md](AGENTS.md) for the shared contract and
[decisions](docs/decisions.md) for implementation defaults.
