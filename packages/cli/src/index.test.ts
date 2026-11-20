import { execFileSync } from 'node:child_process';
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
