import { readFileSync } from 'node:fs';
import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { Board } from '../github.js';
import { configSchema } from '../config.js';
import { SecurityAlerts } from './alerts.js';
import { Enricher, JsonCache } from './enrichment.js';
import { ingestDependabot } from './findings.js';
import { discoverSecurity } from './sync.js';

it.each([403, 404])(
  'skips inaccessible fallback metadata HTTP %s without making alert requests',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('{}', {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const api = new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const result = await new SecurityAlerts(api, 'NormanMul/Pronoia').list(
      'NormanMul/Pronoia',
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings.join(' ')).toContain(String(status));
    expect(
      fetcher.mock.calls.some(([input]) => String(input).includes('/alerts')),
    ).toBe(false);
  },
);

it.each([403, 404])(
  'discovery skips metadata HTTP %s and retains all eligible targets for dispatch',
  async (status) => {
    const api = new Octokit({
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const config = configSchema.parse({
      board_repo: 'NormanMul/Pronoia',
      targets: ['Before/repo', 'Unavailable/repo', 'After/repo'].map(
        (repo) => ({ repo, assessment: 'Synthetic', synthetic: true }),
      ),
    });
    const board = new Board(api, config);
    vi.spyOn(board, 'issues').mockResolvedValue([]);
    vi.spyOn(board, 'isPublic').mockResolvedValue(true);
    vi.spyOn(board, 'setupLabels').mockResolvedValue();
    const alerts = new SecurityAlerts(api);
    vi.spyOn(api.rest.repos, 'get').mockImplementation(async (params) => {
      if (params?.owner === 'Unavailable')
        throw Object.assign(new Error('metadata unavailable'), { status });
      return { data: { private: false } } as Awaited<
        ReturnType<typeof api.rest.repos.get>
      >;
    });
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL(
          '../../../../samples/security/dependabot.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    vi.spyOn(alerts, 'list').mockImplementation(async (repo) => ({
      findings: ingestDependabot(raw, repo).slice(0, 1),
      warnings: [],
    }));
    let number = 0;
    const create = vi
      .spyOn(api.rest.issues, 'create')
      .mockImplementation(
        async () =>
          ({ data: { number: ++number } }) as Awaited<
            ReturnType<typeof api.rest.issues.create>
          >,
      );
    const enricher = new Enricher(api, new JsonCache());
    vi.spyOn(enricher, 'enrich').mockImplementation(
      async (findings) =>
        new Map(
          findings.map((finding) => [
            finding.key,
            {
              cvss: null,
              epss: null,
              epss_percentile: null,
              epss_date: null,
              kev: null,
              kev_due_date: null,
              warnings: [],
            },
          ]),
        ),
    );
    const result = await discoverSecurity(board, alerts, enricher);
    expect(result.created).toBe(2);
    expect(result.issues).toEqual([1, 2]);
    expect(result.warnings.join(' ')).toContain(String(status));
    expect(create).toHaveBeenCalledTimes(2);
  },
);

it('retains strict metadata schema failures rather than interpreting them as inaccessible scans', async () => {
  const api = new Octokit({
    request: {
      fetch: async () =>
        new Response('{"private":"unknown"}', {
          headers: { 'content-type': 'application/json' },
        }),
    },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  await expect(
    new SecurityAlerts(api, 'NormanMul/Pronoia').list('NormanMul/Pronoia'),
  ).rejects.toThrow();
});
