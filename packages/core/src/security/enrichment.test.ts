import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../config.js';
import { ingestDependabot } from './findings.js';
import {
  JsonCache,
  Enricher,
  epssBatches,
  priorityFor,
  slaDueDate,
  slaBreached,
} from './enrichment.js';

const config = configSchema.parse({});

it.each([
  [null, null, true, 'p1'],
  [9, null, false, 'p1'],
  [8.999, 0.499, false, 'p2'],
  [7, 0.5, false, 'p1'],
  [6.999, 0.5, false, 'p2'],
  [7, 0, false, 'p2'],
  [0, 0.1, false, 'p2'],
  [4, 0.0999, false, 'p3'],
  [3.999, null, false, 'p4'],
  [null, null, null, 'p4'],
])(
  'prioritizes boundary CVSS=%s EPSS=%s KEV=%s as %s',
  (cvss, epss, kev, priority) => {
    expect(priorityFor({ cvss, epss, kev }, config)).toBe(priority);
  },
);

it('uses configurable thresholds without dropping the high-CVSS condition for P1 EPSS', () => {
  const custom = configSchema.parse({
    priority: {
      p1_cvss: 10,
      p1_epss: 0.8,
      p2_cvss: 8,
      p2_epss: 0.3,
      p3_cvss: 5,
    },
  });
  expect(priorityFor({ cvss: 7, epss: 0.8, kev: false }, custom)).toBe('p2');
  expect(priorityFor({ cvss: 8, epss: 0.8, kev: false }, custom)).toBe('p1');
});

it.each([
  ['p1', '2026-11-08'],
  ['p2', '2026-11-15'],
  ['p3', '2026-12-01'],
  ['p4', '2027-01-30'],
] as const)('anchors %s SLA to the first-seen WIB day', (priority, due) => {
  expect(slaDueDate('2026-10-31T18:00:00Z', priority, config)).toBe(due);
  expect(slaBreached(due, `${due}T16:59:59Z`)).toBe(false);
  expect(slaBreached(due, `${due}T17:00:00Z`)).toBe(true);
});

it('batches unique EPSS CVEs within the 2000-character query limit', () => {
  const cves = Array.from(
    { length: 400 },
    (_, index) => `CVE-2026-${10000 + index}`,
  );
  const batches = epssBatches([...cves, cves[0] ?? '']);
  expect(batches.flat()).toHaveLength(400);
  for (const batch of batches) {
    expect(
      `?cve=${batch.join(',')}&limit=${batch.length}`.length,
    ).toBeLessThanOrEqual(2000);
  }
  expect(() => epssBatches(['invented'])).toThrow();
  expect(() => epssBatches([`CVE-2026-${'1'.repeat(2500)}`])).toThrow();
});

it('validates cached JSON, retains it for 24h, and atomically persists it', async () => {
  const directory = resolve(`.m2-cache-${randomUUID()}`);
  let now = 100000;
  const load = vi.fn(async () => ({ score: 7 }));
  const schema = z.object({ score: z.number() });
  try {
    const cache = new JsonCache(directory, () => now);
    expect(await cache.get('test', schema, load)).toEqual({ score: 7 });
    now += 24 * 60 * 60 * 1000 - 1;
    expect(
      await new JsonCache(directory, () => now).get('test', schema, load),
    ).toEqual({ score: 7 });
    expect(load).toHaveBeenCalledTimes(1);
    now += 1;
    await cache.get('test', schema, load);
    expect(load).toHaveBeenCalledTimes(2);
    writeFileSync(cache.filename('test'), 'not-json');
    await new JsonCache(directory, () => now).get('test', schema, load);
    expect(load).toHaveBeenCalledTimes(3);
    await expect(
      cache.get('bad', schema, async () => ({ score: 'invented' })),
    ).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function finding() {
  return ingestDependabot(
    [
      {
        number: 1,
        state: 'open',
        created_at: '2026-11-01T12:00:00Z',
        dependency: {
          package: { name: 'lodash', ecosystem: 'npm' },
          manifest_path: 'samples/vuln-app/package-lock.json',
        },
        security_advisory: {
          ghsa_id: 'GHSA-35jh-r3h4-6jhm',
          cve_id: 'CVE-2021-23337',
          severity: 'high',
        },
        security_vulnerability: {
          vulnerable_version_range: '<4.17.21',
          first_patched_version: { identifier: '4.17.21' },
        },
      },
    ],
    'NormanMul/Pronoia',
  );
}

it('enriches with validated advisories, batched EPSS and CISA KEV without refetching cached data', async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const data = url.includes('/advisories/')
      ? { ghsa_id: 'GHSA-35jh-r3h4-6jhm', cvss: { score: 7.2 } }
      : url.includes('first.org')
        ? {
            status: 'OK',
            data: [
              {
                cve: 'CVE-2021-23337',
                epss: '0.51',
                percentile: '0.99',
                date: '2026-11-20',
              },
            ],
          }
        : {
            vulnerabilities: [
              { cveID: 'CVE-2021-23337', dueDate: '2026-12-01' },
            ],
          };
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const github = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const enricher = new Enricher(github, new JsonCache(), { fetch: fetcher });
  const values = finding();
  const result = await enricher.enrich(values);
  expect(result.get(values[0]?.key ?? '')).toMatchObject({
    cvss: 7.2,
    epss: 0.51,
    epss_percentile: 0.99,
    epss_date: '2026-11-20',
    kev: true,
    kev_due_date: '2026-12-01',
    warnings: [],
  });
  await enricher.enrich(values);
  expect(requests).toHaveLength(3);
  expect(
    requests.some((url) => url.includes('/advisories/GHSA-35jh-r3h4-6jhm')),
  ).toBe(true);
});

it('does not fabricate absent scores or KEV membership when services are unavailable', async () => {
  const fetcher: typeof fetch = async () =>
    new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  const github = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const values = finding();
  const result = (
    await new Enricher(github, new JsonCache(), { fetch: fetcher }).enrich(
      values,
    )
  ).get(values[0]?.key ?? '');
  expect(result).toMatchObject({ cvss: null, epss: null, kev: null });
  expect(result?.warnings.join(' ')).toMatch(
    /advisory.*unavailable|CVSS.*unavailable/i,
  );
  expect(result?.warnings.join(' ')).toMatch(/EPSS.*unavailable/i);
  expect(result?.warnings.join(' ')).toMatch(/KEV.*unavailable/i);
});

it('reports missing EPSS rows and invalid enrichment instead of treating them as zero', async () => {
  const fetcher: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes('/advisories/')
          ? { ghsa_id: 'GHSA-35jh-r3h4-6jhm', cvss: { score: 40 } }
          : String(input).includes('first.org')
            ? { status: 'OK', data: [] }
            : { vulnerabilities: [] },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  const github = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const values = finding();
  const result = (
    await new Enricher(github, new JsonCache(), { fetch: fetcher }).enrich(
      values,
    )
  ).get(values[0]?.key ?? '');
  expect(result?.epss).toBeNull();
  expect(result?.kev).toBe(false);
  expect(result?.warnings.join(' ')).toMatch(/missing|unavailable/i);
});

it('optionally consults NVD API 2 and spaces keyed calls at least 650ms apart', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes('/advisories/')
          ? { ghsa_id: 'GHSA-35jh-r3h4-6jhm' }
          : String(input).includes('nvd.nist.gov')
            ? {
                vulnerabilities: [
                  {
                    cve: {
                      id: new URL(String(input)).searchParams.get('cveId'),
                      metrics: {
                        cvssMetricV31: [{ cvssData: { baseScore: 8.1 } }],
                      },
                    },
                  },
                ],
              }
            : String(input).includes('first.org')
              ? { status: 'OK', data: [] }
              : { vulnerabilities: [] },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  const github = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const values = finding();
  const first = values[0];
  if (!first) throw new Error('Missing fixture');
  const second = {
    ...first,
    key: 'dependabot/normanmul/pronoia/2',
    number: 2,
    cve_ids: ['CVE-2021-44906'],
  };
  const enricher = new Enricher(github, new JsonCache(), {
    fetch: fetcher,
    nvd: { apiKey: 'test-only-noncredential' },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const result = await enricher.enrich([first, second]);
  expect(result.get(first.key)?.cvss).toBe(8.1);
  expect(sleeps).toContain(650);
});
