import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
  ingestDependabot,
  ingestCodeScanning,
  ingestSecretScanning,
  ingestSarif,
  dedupeFindings,
  safePath,
  safeText,
  publicationAllowed,
  sanitizedSarif,
} from './findings.js';

const repo = 'NormanMul/Pronoia';
function sample(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../samples/security/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

it('normalizes and deduplicates source/repository/alert identities', () => {
  const findings = ingestDependabot(sample('dependabot'), repo);
  expect(findings[0]).toMatchObject({
    key: 'dependabot/normanmul/pronoia/1',
    source: 'dependabot',
    number: 1,
    severity: 'high',
    cve_ids: ['CVE-2021-23337'],
    ghsa_ids: ['GHSA-35jh-r3h4-6jhm'],
    path: 'samples/vuln-app/package-lock.json',
    vulnerable_version_range: '<4.17.21',
    first_patched_version: '4.17.21',
    state: 'open',
  });

  expect(dedupeFindings([...findings, ...findings])).toHaveLength(2);
  expect(
    ingestDependabot(sample('dependabot'), 'Fabrikam/demo')[0]?.key,
  ).not.toBe(findings[0]?.key);
});

it('uses chronological timestamps, not offset-string order, to choose a duplicate alert state', () => {
  const first = ingestDependabot(sample('dependabot'), repo)[0];
  if (!first) throw new Error('Missing fixture');
  const result = dedupeFindings([
    { ...first, state: 'fixed', updated_at: '2026-11-20T23:00:00+07:00' },
    { ...first, state: 'open', updated_at: '2026-11-20T17:00:00Z' },
  ]);
  expect(result[0]?.state).toBe('open');
});

it('uses the security severity and excludes code snippets and scanner messages', () => {
  const [finding] = ingestCodeScanning(sample('code-scanning'), repo);
  expect(finding).toMatchObject({
    key: 'code-scanning/normanmul/pronoia/3',
    severity: 'high',
    rule_id: 'js/sql-injection',
    path: 'samples/vuln-app/server.mjs',
  });
  expect(JSON.stringify(finding)).not.toContain('untrusted-result-message');
});

it('never retains a secret value or secret-scanning locations', () => {
  const raw = sample('secret-scanning') as Record<string, unknown>[];
  const sentinel = ['not', 'for', 'publication'].join('-');
  const input = raw.map((row) => ({
    ...row,
    secret: sentinel,
    first_location_detected: {
      snippet: sentinel,
      path: 'C:\\customer\\private',
    },
  }));
  const findings = ingestSecretScanning(input, repo);
  expect(findings[0]).toMatchObject({
    source: 'secret-scanning',
    number: 4,
    path: null,
    state: 'open',
  });
  expect(findings[1]?.state).toBe('fixed');
  expect(JSON.stringify(findings)).not.toContain(sentinel);
  expect(JSON.stringify(findings)).not.toContain('customer');
});

it('accepts SARIF 2.1.0 only and keeps stable rule/path/fingerprint identities', () => {
  const raw = sample('sarif');
  const findings = ingestSarif(raw, repo, '2026-11-20T12:00:00Z');
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    source: 'sarif',
    rule_id: 'CVE-2021-23337',
    cve_ids: ['CVE-2021-23337'],
    path: 'samples/vuln-app/package-lock.json',
    severity: 'high',
  });
  expect(ingestSarif(raw, repo, '2026-11-21T12:00:00Z')[0]?.key).toBe(
    findings[0]?.key,
  );
  expect(JSON.stringify(findings)).not.toContain('untrusted-result-message');
  expect(() => ingestSarif({ version: '2.0.0', runs: [] }, repo)).toThrow();
});

it.each([
  'C:\\customer\\app.ts',
  'file:///C:/customer/app.ts',
  '/home/customer/app.ts',
  '\\\\customer\\share\\app.ts',
  '../customer/app.ts',
  '%2Fhome%2Fcustomer%2Fapp.ts',
  'https://customer.invalid/app.ts',
  'src/\u0000app.ts',
  'src/\napp.ts',
])('does not retain machine paths: %s', (path) => {
  expect(safePath(path)).toBeNull();
});

it('normalizes repository-relative paths and redacts unsafe text', () => {
  expect(safePath('src\\demo%20test.ts')).toBe('src/demo test.ts');
  expect(
    safeText('password=do-not-retain C:\\customer\\notes.txt'),
  ).not.toContain('do-not-retain');
  expect(
    safeText('password=do-not-retain C:\\customer\\notes.txt'),
  ).not.toContain('customer');
  expect(safeText('https://docs.github.com/en/code-security')).toBe(
    'https://docs.github.com/en/code-security',
  );
  expect(safeText('Observed /work/customer/private.txt')).not.toContain(
    'customer',
  );
});

it('rejects malformed ingestion boundaries instead of inventing fields', () => {
  expect(() => ingestDependabot([{ number: -1 }], repo)).toThrow();
  expect(() => ingestCodeScanning([{ state: 'invented' }], repo)).toThrow();
  expect(() => ingestSecretScanning([{ state: 'invented' }], repo)).toThrow();
  expect(() => ingestSarif(sample('sarif'), '../outside')).toThrow();
});

it('redacts credential values in quoted JSON without retaining a source snippet', () => {
  const sentinel = ['never', 'publish', 'credential'].join('-');
  expect(safeText(JSON.stringify({ password: sentinel }))).not.toContain(
    sentinel,
  );
});

it('permits public dogfooding or attested synthetic public targets, never private data', () => {
  expect(publicationAllowed(true, false, repo, repo, false)).toBe(true);
  expect(publicationAllowed(true, false, 'Fabrikam/demo', repo, false)).toBe(
    false,
  );
  expect(publicationAllowed(true, false, 'Fabrikam/demo', repo, true)).toBe(
    true,
  );
  expect(publicationAllowed(true, true, 'Fabrikam/demo', repo, true)).toBe(
    false,
  );
  expect(publicationAllowed(false, true, 'Fabrikam/demo', repo, false)).toBe(
    true,
  );
});

it('relativizes only explicit scanner-root paths and preserves identities through safe SARIF export', () => {
  const raw = sample('sarif') as {
    runs: {
      results: {
        locations: {
          physicalLocation: { artifactLocation: { uri: string } };
        }[];
      }[];
    }[];
  };
  for (const result of raw.runs[0]?.results ?? []) {
    const location = result.locations[0];
    if (location)
      location.physicalLocation.artifactLocation.uri = pathToFileURL(
        resolve('samples/vuln-app/package-lock.json'),
      ).href;
  }
  const findings = ingestSarif(
    raw,
    repo,
    '2026-11-20T12:00:00Z',
    process.cwd(),
  );
  expect(findings[0]?.path).toBe('samples/vuln-app/package-lock.json');
  const clean = sanitizedSarif(raw, repo, process.cwd());
  expect(JSON.stringify(clean)).not.toContain('untrusted-result-message');
  expect(JSON.stringify(clean)).not.toContain(process.cwd());
  expect(ingestSarif(clean, repo)[0]?.key).toBe(findings[0]?.key);
});

it('rejects SARIF results without a message instead of accepting a malformed report', () => {
  expect(() =>
    ingestSarif(
      {
        version: '2.1.0',
        runs: [
          { tool: { driver: { name: 'demo' } }, results: [{ ruleId: 'demo' }] },
        ],
      },
      repo,
    ),
  ).toThrow();
});

it('accepts the SARIF minus-one artifact-index sentinel used by real OSV reports', () => {
  const report = (index: number) => ({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'OSV-Scanner' } },
        artifacts: [
          { location: { uri: 'samples/vuln-app/package-lock.json', index } },
        ],
        results: [
          {
            ruleId: 'GHSA-35jh-r3h4-6jhm',
            message: { text: 'Synthetic vulnerable dependency.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: 'samples/vuln-app/package-lock.json',
                    index,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const finding = ingestSarif(report(-1), repo)[0];
  expect(finding?.path).toBe('samples/vuln-app/package-lock.json');
  expect(ingestSarif(sanitizedSarif(report(-1), repo), repo)[0]?.key).toBe(
    finding?.key,
  );
  expect(() => ingestSarif(report(-2), repo)).toThrow();
});
