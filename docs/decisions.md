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
