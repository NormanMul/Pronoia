import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { SecurityAlerts } from './alerts.js';

function fixture(privateRepo = false) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    return new Response(
      JSON.stringify(path.endsWith('/alerts') ? [] : { private: privateRepo }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  const api = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  return { api, fetcher };
}

it('never sends a fallback board token to an external target, and warns/skips it', async () => {
  const f = fixture();
  const alerts = new SecurityAlerts(f.api, 'NormanMul/Pronoia');
  const result = await alerts.list('Fabrikam/external');
  expect(result.findings).toEqual([]);
  expect(result.warnings.join(' ')).toMatch(/separate.*READ|READ.*credential/i);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('permits the board-token fallback for its own public repository only', async () => {
  const f = fixture();
  const result = await new SecurityAlerts(f.api, 'NormanMul/Pronoia').list(
    'NormanMul/Pronoia',
  );
  expect(result.warnings).toEqual([]);
  expect(f.fetcher).toHaveBeenCalled();
  const privateFixture = fixture(true);
  const denied = await new SecurityAlerts(
    privateFixture.api,
    'NormanMul/Pronoia',
  ).list('NormanMul/Pronoia');
  expect(denied.warnings.join(' ')).toMatch(/private.*READ|READ.*private/i);
  expect(
    privateFixture.fetcher.mock.calls.some(([url]) =>
      String(url).includes('/alerts'),
    ),
  ).toBe(false);
});

it('allows an explicitly supplied target READ client for external scopes', async () => {
  const f = fixture();
  expect(
    await new SecurityAlerts(f.api).list('Fabrikam/external'),
  ).toMatchObject({ warnings: [] });
  expect(f.fetcher).toHaveBeenCalled();
});
