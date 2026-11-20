import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { repoSchema } from '../config.js';
import { severitySchema } from '../workflow/schemas.js';

export const securitySourceSchema = z.enum([
  'dependabot',
  'code-scanning',
  'secret-scanning',
  'sarif',
]);
export const alertStateSchema = z.enum(['open', 'fixed', 'dismissed']);
export const cveSchema = z
  .string()
  .max(100)
  .regex(/^CVE-\d{4}-\d{4,}$/);
export const ghsaSchema = z
  .string()
  .regex(/^GHSA-[a-z0-9]{4}(?:-[a-z0-9]{4}){2}$/);
const timestamp = z.iso.datetime({ offset: true });
const score = z.number().min(0).max(10);

export function safePath(value: string | null | undefined): string | null {
  if (!value || value.length > 1000) return null;
  let path: string;
  try {
    path = decodeURIComponent(value).replaceAll('\\', '/').replace(/^\.\//, '');
  } catch {
    return null;
  }
  if (
    !path ||
    /^\/|^[a-z][a-z0-9+.-]*:/i.test(path) ||
    /[:?#]/.test(path) ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path.split('/').includes('..')
  )
    return null;
  return path;
}

export function safeText(value: string, maxLength = 10000): string {
  return value
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[credential redacted]')
    .replace(
      /\b(?:Bearer\s+|(?:password|secret|token|api[_-]?key|connection[_-]?string)["']?\s*[:=]\s*)[^\s,;}]+/gi,
      '[credential redacted]',
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[credential redacted]',
    )
    .replace(
      /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi,
      '[credential URL redacted]',
    )
    .replace(
      /(?:file:\/\/\/)?\b[a-z]:[\\/][^\s]+|\\\\[^\s]+|(?<![\w:/])\/[^\s/]+\/[^\s]+/gi,
      '[machine path omitted]',
    )
    .slice(0, maxLength);
}

export const findingSchema = z
  .object({
    source: securitySourceSchema,
    repo: repoSchema,
    key: z.string().min(1).max(500),
    number: z.number().int().positive().nullable(),
    title: z.string().min(1).max(256),
    description: z.string().max(10000),
    severity: severitySchema,
    path: z
      .string()
      .max(1000)
      .nullable()
      .refine((path) => path === null || safePath(path) === path),
    link: z.url().refine((url) => {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'github.com' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search
      );
    }),
    cve_ids: z.array(cveSchema),
    ghsa_ids: z.array(ghsaSchema),
    cvss: score.nullable(),
    package_name: z.string().max(500).nullable(),
    ecosystem: z.string().max(100).nullable(),
    vulnerable_version_range: z.string().max(1000).nullable(),
    first_patched_version: z.string().max(1000).nullable(),
    rule_id: z.string().max(500).nullable(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    state: alertStateSchema,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

const baseAlert = z.object({
  number: z.number().int().positive(),
  created_at: timestamp,
  updated_at: timestamp.nullish(),
});
const cvssSchema = z.object({ score: score.nullish() });
export const advisorySchema = z.object({
  ghsa_id: ghsaSchema,
  cve_id: cveSchema.nullish(),
  severity: severitySchema.optional(),
  cvss: cvssSchema.nullish(),
  cvss_severities: z
    .object({
      cvss_v3: cvssSchema.nullish(),
      cvss_v4: cvssSchema.nullish(),
    })
    .nullish(),
  identifiers: z
    .array(z.object({ type: z.string(), value: z.string() }))
    .default([]),
});
export type Advisory = z.infer<typeof advisorySchema>;

export function advisoryScore(advisory: Advisory): number | null {
  const scores = [
    advisory.cvss?.score,
    advisory.cvss_severities?.cvss_v3?.score,
    advisory.cvss_severities?.cvss_v4?.score,
  ].filter((value): value is number => value !== null && value !== undefined);
  return scores.length ? Math.max(...scores) : null;
}

export const dependabotSchema = baseAlert.extend({
  state: z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']),
  dependency: z.object({
    package: z.object({
      name: z.string().max(500),
      ecosystem: z.string().max(100),
    }),
    manifest_path: z.string().max(2000),
  }),
  security_advisory: advisorySchema,
  security_vulnerability: z.object({
    vulnerable_version_range: z.string().max(1000),
    first_patched_version: z
      .object({ identifier: z.string().max(1000) })
      .nullable(),
  }),
});
export const codeScanningSchema = baseAlert.extend({
  state: alertStateSchema,
  rule: z.object({
    id: z.string().max(500).nullable(),
    description: z.string().max(10000).default('Code scanning finding'),
    severity: z.enum(['none', 'note', 'warning', 'error']).nullish(),
    security_severity_level: severitySchema.nullish(),
    tags: z.array(z.string()).nullish(),
  }),
  most_recent_instance: z
    .object({
      location: z.object({ path: z.string().max(2000) }).optional(),
    })
    .optional(),
});
export const secretScanningSchema = baseAlert.extend({
  state: z.enum(['open', 'resolved']),
  secret_type: z.string().max(200),
  resolution: z
    .enum([
      'false_positive',
      'wont_fix',
      'revoked',
      'used_in_tests',
      'pattern_edited',
      'pattern_deleted',
    ])
    .nullish(),
});

function ids(text: string, kind: 'cve' | 'ghsa'): string[] {
  return [
    ...new Set(
      text.match(
        kind === 'cve'
          ? /CVE-\d{4}-\d{4,}/g
          : /GHSA-[a-z0-9]{4}(?:-[a-z0-9]{4}){2}/g,
      ) ?? [],
    ),
  ];
}

function base(
  source: Finding['source'],
  repository: string,
  alert: z.infer<typeof baseAlert>,
) {
  const repo = repoSchema.parse(repository);
  return {
    source,
    repo,
    key: `${source}/${repo.toLowerCase()}/${alert.number}`,
    number: alert.number,
    link: `https://github.com/${repo}/security/${source === 'dependabot' ? 'dependabot' : source === 'code-scanning' ? 'code-scanning' : 'secret-scanning'}/${alert.number}`,
    created_at: alert.created_at,
    updated_at: alert.updated_at ?? alert.created_at,
    cve_ids: [] as string[],
    ghsa_ids: [] as string[],
    cvss: null,
    package_name: null,
    ecosystem: null,
    vulnerable_version_range: null,
    first_patched_version: null,
    rule_id: null,
    path: null,
  };
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const result = new Map<string, Finding>();
  for (const input of findings) {
    const finding = findingSchema.parse(input);
    const previous = result.get(finding.key);
    if (
      !previous ||
      Date.parse(finding.updated_at) > Date.parse(previous.updated_at)
    )
      result.set(finding.key, finding);
  }
  return [...result.values()];
}

export function ingestDependabot(input: unknown, repo: string): Finding[] {
  return dedupeFindings(
    z
      .array(dependabotSchema)
      .parse(input)
      .map((alert) => {
        const advisory = alert.security_advisory;
        const idText = [
          advisory.cve_id,
          ...advisory.identifiers.map((id) => id.value),
        ].join(' ');
        const name = safeText(alert.dependency.package.name);
        return findingSchema.parse({
          ...base('dependabot', repo, alert),
          title: `${name}: ${advisory.ghsa_id}`.slice(0, 256),
          description: `Dependency advisory ${advisory.ghsa_id}. Review the upstream advisory and the patched version; source snippets are intentionally omitted.`,
          severity: advisory.severity ?? 'info',
          path: safePath(alert.dependency.manifest_path),
          cve_ids: ids(idText, 'cve'),
          ghsa_ids: [advisory.ghsa_id],
          cvss: advisoryScore(advisory),
          package_name: name,
          ecosystem: safeText(alert.dependency.package.ecosystem),
          vulnerable_version_range: safeText(
            alert.security_vulnerability.vulnerable_version_range,
          ),
          first_patched_version: alert.security_vulnerability
            .first_patched_version
            ? safeText(
                alert.security_vulnerability.first_patched_version.identifier,
              )
            : null,
          state: alert.state === 'auto_dismissed' ? 'dismissed' : alert.state,
        });
      }),
  );
}

function levelSeverity(level: string | null | undefined): Finding['severity'] {
  return level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'info';
}

export function ingestCodeScanning(input: unknown, repo: string): Finding[] {
  return dedupeFindings(
    z
      .array(codeScanningSchema)
      .parse(input)
      .map((alert) =>
        findingSchema.parse({
          ...base('code-scanning', repo, alert),
          title:
            `Code scanning: ${safeText(alert.rule.id ?? `alert ${alert.number}`)}`.slice(
              0,
              256,
            ),
          description: safeText(alert.rule.description),
          severity:
            alert.rule.security_severity_level ??
            levelSeverity(alert.rule.severity),
          path: safePath(alert.most_recent_instance?.location?.path),
          rule_id: alert.rule.id ? safeText(alert.rule.id) : null,
          cve_ids: ids((alert.rule.tags ?? []).join(' '), 'cve'),
          state: alert.state,
        }),
      ),
  );
}

export function ingestSecretScanning(input: unknown, repo: string): Finding[] {
  // The schema strips literal secrets and locations before any processing.
  return dedupeFindings(
    z
      .array(secretScanningSchema)
      .parse(input)
      .map((alert) =>
        findingSchema.parse({
          ...base('secret-scanning', repo, alert),
          title: `Secret scanning alert #${alert.number}`,
          description:
            'Review the source alert privately, revoke affected credentials, then verify remediation. Secret values and locations are never copied to the board.',
          severity: 'high',
          rule_id: safeText(alert.secret_type),
          state:
            alert.state === 'open'
              ? 'open'
              : alert.resolution === 'revoked'
                ? 'fixed'
                : 'dismissed',
        }),
      ),
  );
}

const artifactLocation = z.object({
  uri: z.string().max(2000).optional(),
  index: z.number().int().nonnegative().optional(),
});
const sarifRule = z.object({
  id: z.string().min(1).max(500),
  deprecatedIds: z.array(z.string()).default([]),
  shortDescription: z.object({ text: z.string().max(10000) }).optional(),
  properties: z
    .object({
      'security-severity': z.union([z.string(), score]).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});
export const sarifSchema = z.object({
  version: z.literal('2.1.0'),
  runs: z
    .array(
      z.object({
        tool: z.object({
          driver: z.object({
            name: z.string().min(1),
            rules: z.array(sarifRule).default([]),
          }),
        }),
        artifacts: z
          .array(z.object({ location: artifactLocation }))
          .default([]),
        results: z
          .array(
            z.object({
              ruleId: z.string().min(1).max(500).optional(),
              ruleIndex: z.number().int().nonnegative().optional(),
              level: z.enum(['none', 'note', 'warning', 'error']).optional(),
              message: z
                .object({
                  text: z.string().max(30000).optional(),
                  markdown: z.string().max(30000).optional(),
                })
                .refine(
                  (message) =>
                    message.text !== undefined ||
                    message.markdown !== undefined,
                ),
              partialFingerprints: z
                .record(z.string(), z.string().max(2000))
                .default({}),
              fingerprints: z
                .record(z.string(), z.string().max(2000))
                .default({}),
              locations: z
                .array(
                  z.object({
                    physicalLocation: z
                      .object({
                        artifactLocation,
                        region: z
                          .object({
                            startLine: z.number().int().positive().optional(),
                          })
                          .optional(),
                      })
                      .optional(),
                  }),
                )
                .default([]),
              baselineState: z
                .enum(['new', 'unchanged', 'updated', 'absent'])
                .optional(),
              suppressions: z
                .array(z.object({ status: z.string().optional() }))
                .default([]),
            }),
          )
          .max(50000)
          .default([]),
      }),
    )
    .max(100),
});

function sarifPath(uri: string | undefined, root?: string): string | null {
  const path = safePath(uri);
  if (path || !uri || !root) return path;
  try {
    const absolute = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    if (!isAbsolute(absolute)) return null;
    return safePath(relative(resolve(root), absolute));
  } catch {
    return null;
  }
}

export function ingestSarif(
  input: unknown,
  repository: string,
  at = new Date().toISOString(),
  artifactRoot?: string,
): Finding[] {
  const repo = repoSchema.parse(repository);
  timestamp.parse(at);
  const findings: Finding[] = [];
  for (const run of sarifSchema.parse(input).runs) {
    for (const result of run.results) {
      const rule = result.ruleId
        ? run.tool.driver.rules.find((rule) => rule.id === result.ruleId)
        : run.tool.driver.rules[result.ruleIndex ?? -1];
      const ruleId = result.ruleId ?? rule?.id;
      if (!ruleId)
        throw new Error('SARIF result needs a rule ID or a valid rule index.');
      const location = result.locations[0]?.physicalLocation;
      const artifact = location?.artifactLocation;
      const path = sarifPath(
        artifact?.uri ?? run.artifacts[artifact?.index ?? -1]?.location.uri,
        artifactRoot,
      );
      const fingerprints = Object.keys(result.partialFingerprints).length
        ? result.partialFingerprints
        : result.fingerprints;
      const fingerprint = Object.keys(fingerprints).length
        ? Object.entries(fingerprints).sort(([a], [b]) => a.localeCompare(b))
        : [['line', String(location?.region?.startLine ?? 0)]];
      const fingerprintHash =
        Object.keys(fingerprints).length === 1 &&
        /^[a-f0-9]{64}$/.test(fingerprints['pronoia/v1'] ?? '')
          ? fingerprints['pronoia/v1']
          : createHash('sha256')
              .update(JSON.stringify(fingerprint))
              .digest('hex');
      const hash = createHash('sha256')
        .update(JSON.stringify([ruleId, path, fingerprintHash]))
        .digest('hex');
      const rawScore = rule?.properties?.['security-severity'];
      const parsedScore = score.safeParse(
        rawScore === undefined ? undefined : Number(rawScore),
      );
      const cvss = parsedScore.success ? parsedScore.data : null;
      const idText = [
        ruleId,
        ...(rule?.deprecatedIds ?? []),
        ...(rule?.properties?.tags ?? []),
      ].join(' ');
      findings.push(
        findingSchema.parse({
          ...base('sarif', repo, { number: 1, created_at: at, updated_at: at }),
          number: null,
          key: `sarif/${repo.toLowerCase()}/${hash}`,
          link: `https://github.com/${repo}/security/code-scanning`,
          title: `SARIF: ${safeText(ruleId)}`.slice(0, 256),
          description: safeText(
            rule?.shortDescription?.text ??
              'Scanner finding. Review the source report privately; source messages and snippets are omitted.',
          ),
          severity:
            cvss === null
              ? levelSeverity(result.level)
              : cvss >= 9
                ? 'critical'
                : cvss >= 7
                  ? 'high'
                  : cvss >= 4
                    ? 'medium'
                    : 'low',
          path,
          rule_id: safeText(ruleId),
          fingerprint: fingerprintHash,
          cve_ids: ids(idText, 'cve'),
          ghsa_ids: ids(idText, 'ghsa'),
          cvss,
          state:
            result.baselineState === 'absent'
              ? 'fixed'
              : result.suppressions.some(
                    (suppression) => suppression.status === 'accepted',
                  )
                ? 'dismissed'
                : 'open',
        }),
      );
    }
  }
  return dedupeFindings(findings);
}

export function sanitizedSarif(
  input: unknown,
  repo: string,
  artifactRoot?: string,
) {
  const findings = ingestSarif(
    input,
    repo,
    new Date().toISOString(),
    artifactRoot,
  );
  const clean = {
    version: '2.1.0' as const,
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'pronoia-sanitized',
            rules: [
              ...new Map(
                findings.map((finding) => [
                  finding.rule_id,
                  {
                    id: finding.rule_id,
                    shortDescription: { text: finding.description },
                    deprecatedIds: [...finding.cve_ids, ...finding.ghsa_ids],
                    ...(finding.cvss !== null
                      ? {
                          properties: {
                            'security-severity': String(finding.cvss),
                          },
                        }
                      : {}),
                  },
                ]),
              ).values(),
            ],
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.rule_id,
          level:
            finding.severity === 'high' || finding.severity === 'critical'
              ? 'error'
              : finding.severity === 'medium'
                ? 'warning'
                : 'note',
          message: {
            text: 'Normalized security finding. Source snippets and scanner messages intentionally omitted.',
          },
          partialFingerprints: { 'pronoia/v1': finding.fingerprint },
          ...(finding.path
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.path },
                    },
                  },
                ],
              }
            : {}),
          ...(finding.state === 'fixed'
            ? { baselineState: 'absent' }
            : finding.state === 'dismissed'
              ? { suppressions: [{ kind: 'external', status: 'accepted' }] }
              : {}),
        })),
      },
    ],
  };
  sarifSchema.parse(clean);
  return clean;
}

export function publicationAllowed(
  boardPublic: boolean,
  targetPrivate: boolean,
  target: string,
  board: string,
  synthetic: boolean,
): boolean {
  return (
    !boardPublic ||
    (!targetPrivate &&
      (target.toLowerCase() === board.toLowerCase() || synthetic))
  );
}
