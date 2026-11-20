# Intentionally vulnerable synthetic fixture

**Never deploy this app, run it on a shared machine, mount customer/host data,
or put credentials here.** The scanner workflow only reads source and lockfiles;
it does not install sample dependencies, run build scripts, or start a server.

This small Express + built-in SQLite app contains:

- deliberately concatenated SQL in `/search`, against an in-memory fictional
  table only;
- deliberate path traversal in `/files`, contained by Node's filesystem
  permission boundary to this sample directory;
- old Express 4.17.1, lodash 4.17.20 and minimist 1.2.5 dependency fixtures with
  known public advisories.

The committed lockfile is generated without running installation scripts:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

If runtime demonstration is needed, use a disposable offline VM/container with
no host mounts and only synthetic files. From this directory, install without
scripts and use `npm start`. It binds **127.0.0.1:3033** only, requires Node 22.17+
and `--permission --allow-fs-read=.` and refuses broad home-directory access.
Never widen the permission grant or add symlinks. This permission check is a
second boundary, not a substitute for isolation.

The root application's dependencies are separate. Do not dismiss real findings
because this sample intentionally stays vulnerable. Dependabot may propose
sample upgrades; review them as demonstration changes.
