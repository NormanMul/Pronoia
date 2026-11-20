import { readFileSync } from 'node:fs';
import { Octokit } from 'octokit';
import { expect, it } from 'vitest';
import {
  SecurityAlerts,
  mergedReferences,
  dismissalParameters,
} from './alerts.js';

function sample(name: string): unknown[] {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../samples/security/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown[];
}
function api(fetcher: typeof fetch): Octokit {
  return new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
}

it('reads all sources, hides secrets at the API and validates before normalizing', async () => {
  const requests: URL[] = [];
  const client = new SecurityAlerts(
    api(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const name = url.pathname.includes('dependabot')
        ? 'dependabot'
        : url.pathname.includes('code-scanning')
          ? 'code-scanning'
          : 'secret-scanning';
      return new Response(JSON.stringify(sample(name)), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const result = await client.list('NormanMul/Pronoia');
  expect(result.findings).toHaveLength(5);
  expect(
    requests
      .find((url) => url.pathname.includes('secret-scanning'))
      ?.searchParams.get('hide_secret'),
  ).toBe('true');
  expect(result.warnings).toEqual([]);
});

it.each([403, 404])(
  'logs and skips unavailable scans with HTTP %s',
  async (status) => {
    const client = new SecurityAlerts(
      api(
        async () =>
          new Response('{}', {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const result = await client.list('NormanMul/Pronoia');
    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    expect(
      await client.get({
        repo: 'NormanMul/Pronoia',
        source: 'dependabot',
        number: 1,
      }),
    ).toMatchObject({
      finding: null,
      warning: expect.stringContaining(String(status)),
    });
  },
);

it('surfaces non-permission failures and malformed alerts explicitly', async () => {
  const failed = new SecurityAlerts(
    api(
      async () =>
        new Response('{}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await expect(failed.list('NormanMul/Pronoia')).rejects.toThrow(/503|failed/i);
  const invalid = new SecurityAlerts(
    api(
      async () =>
        new Response('[{"number":-1}]', {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await expect(invalid.list('NormanMul/Pronoia')).rejects.toThrow(
    /invalid|schema/i,
  );
});

it('requires every referenced alert to be fixed, never trusts dismissed or missing alerts', async () => {
  const client = new SecurityAlerts(
    api(async (input) => {
      const url = new URL(String(input));
      const row = sample('dependabot').at(url.pathname.endsWith('/2') ? 1 : 0);
      return new Response(JSON.stringify(row), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  expect(await client.fixed([])).toBe(false);
  expect(
    await client.fixed([
      { repo: 'NormanMul/Pronoia', source: 'dependabot', number: 2 },
    ]),
  ).toBe(true);
  expect(
    await client.fixed([
      { repo: 'NormanMul/Pronoia', source: 'dependabot', number: 1 },
      { repo: 'NormanMul/Pronoia', source: 'dependabot', number: 2 },
    ]),
  ).toBe(false);
});

it('uses only merged same-repository PR references, excluding cross-repo and fork PRs', () => {
  const pr = {
    merged_at: '2026-11-20T12:00:00Z',
    title: 'Fix demo (Refs #1)',
    body: 'Refs #2, #3. Fixes NormanMul/Pronoia#4. Refs Fabrikam/demo#5.',
    base: { repo: { full_name: 'NormanMul/Pronoia' } },
    head: { repo: { full_name: 'NormanMul/Pronoia' } },
  };
  expect(mergedReferences(pr, 'NormanMul/Pronoia')).toEqual([1, 2, 3, 4]);
  expect(
    mergedReferences({ ...pr, merged_at: null }, 'NormanMul/Pronoia'),
  ).toEqual([]);
  expect(
    mergedReferences(
      { ...pr, head: { repo: { full_name: 'Fabrikam/fork' } } },
      'NormanMul/Pronoia',
    ),
  ).toEqual([]);
});

it.each([
  [
    'dependabot',
    'false-positive',
    { state: 'dismissed', dismissed_reason: 'inaccurate' },
  ],
  [
    'dependabot',
    'not-applicable',
    { state: 'dismissed', dismissed_reason: 'not_used' },
  ],
  [
    'dependabot',
    'risk-accepted',
    { state: 'dismissed', dismissed_reason: 'tolerable_risk' },
  ],
  [
    'code-scanning',
    'false-positive',
    { state: 'dismissed', dismissed_reason: 'false positive' },
  ],
  [
    'code-scanning',
    'not-applicable',
    { state: 'dismissed', dismissed_reason: "won't fix" },
  ],
  [
    'secret-scanning',
    'risk-accepted',
    { state: 'resolved', resolution: 'wont_fix' },
  ],
] as const)(
  'maps approved %s %s to documented dismissal enums',
  (source, dispute, expected) => {
    expect(dismissalParameters(source, dispute)).toEqual(expected);
  },
);
