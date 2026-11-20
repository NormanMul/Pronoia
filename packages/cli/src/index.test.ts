import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('prints a synthetic demo plan without GitHub credentials or writes', () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [entry, 'demo-seed', '--dry-run'],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', PRONOIA_AGENT_NAME: '' },
      timeout: 15000,
    },
  );
  const plan: unknown = JSON.parse(output);
  expect(plan).toMatchObject({ dry_run: true, planned: 20 });
}, 20000);

function run(args: string[]): string {
  return execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../dist/index.js', import.meta.url)), ...args],
    {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        GITHUB_TOKEN: '',
        PRONOIA_TARGET_TOKEN: '',
        PRONOIA_AGENT_TOKEN: '',
        PRONOIA_AGENT_NAME: '',
      },
    },
  );
}

it('previews synthetic SARIF without credentials, source messages or machine paths', () => {
  const output = run([
    'ingest-sarif',
    'samples/security/sarif.json',
    '--repo',
    'NormanMul/Pronoia',
    '--dry-run',
    '--synthetic',
  ]);
  expect(JSON.parse(output)).toMatchObject({ dry_run: true, planned: 1 });
  expect(output).not.toContain('untrusted-result-message');
  expect(output).not.toContain(process.cwd());
});

it('previews all synthetic scanner fixture sources without credentials or network calls', () => {
  const output = run([
    'sync-security',
    '--fixtures',
    'samples/security',
    '--dry-run',
    '--synthetic',
  ]);
  expect(JSON.parse(output)).toMatchObject({ dry_run: true, planned: 5 });
  expect(output).not.toContain('untrusted-result-message');
});

it.each([
  ['process-issue', '--issue', '1', '--mode', 'sync'],
  ['sync-security', '--issue', '1'],
  ['verify-on-merge', '--pull', '9', '--issue', '1'],
  ['ai', '--issue', '1'],
])(
  'rejects local authoritative/AI operation %s before using credentials',
  (...args) => {
    expect(() => run(args)).toThrow(/Authoritative|GitHub Actions/);
  },
);

it('does not log machine paths when a security input file is missing', () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      entry,
      'ingest-sarif',
      resolve('missing-synthetic.sarif'),
      '--dry-run',
      '--synthetic',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GITHUB_TOKEN: '', GITHUB_ACTIONS: '' },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain(process.cwd());
});
