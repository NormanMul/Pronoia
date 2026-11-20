import { Octokit } from 'octokit';
import { expect, it } from 'vitest';
import { configSchema } from '../config.js';
import { ingestDependabot } from './findings.js';
import { Enricher, JsonCache, priorityFor } from './enrichment.js';

it.each(['cve_id', 'identifiers'] as const)(
  'resolves GHSA-only %s aliases before querying EPSS/KEV and assigns KEV P1',
  async (aliasField) => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      const data = url.includes('/advisories/')
        ? {
            ghsa_id: 'GHSA-35jh-r3h4-6jhm',
            cvss: { score: 7.2 },
            ...(aliasField === 'cve_id'
              ? { cve_id: 'CVE-2021-23337' }
              : { identifiers: [{ type: 'CVE', value: 'CVE-2021-23337' }] }),
          }
        : url.includes('first.org')
          ? {
              status: 'OK',
              data: [
                {
                  cve: 'CVE-2021-23337',
                  epss: '0.01',
                  percentile: '0.2',
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
    const api = new Octokit({
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const findings = ingestDependabot(
      [
        {
          number: 1,
          state: 'open',
          created_at: '2026-11-20T12:00:00Z',
          dependency: {
            package: { name: 'lodash', ecosystem: 'npm' },
            manifest_path: 'samples/vuln-app/package-lock.json',
          },
          security_advisory: {
            ghsa_id: 'GHSA-35jh-r3h4-6jhm',
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
    const finding = findings[0];
    if (!finding) throw new Error('Missing synthetic fixture');
    expect(finding.cve_ids).toEqual([]);
    const enriched = (
      await new Enricher(api, new JsonCache(), { fetch: fetcher }).enrich(
        findings,
      )
    ).get(finding.key);
    expect(enriched).toMatchObject({
      cve_ids: ['CVE-2021-23337'],
      kev: true,
      cvss: 7.2,
      epss: 0.01,
    });
    if (!enriched) throw new Error('Missing enrichment');
    expect(priorityFor(enriched, configSchema.parse({}))).toBe('p1');
    expect(requests[0]).toContain('/advisories/GHSA-35jh-r3h4-6jhm');
    expect(requests.find((url) => url.includes('first.org'))).toContain(
      'cve=CVE-2021-23337',
    );
    expect(enriched.warnings).toEqual([]);
  },
);
