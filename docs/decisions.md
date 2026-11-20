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
