import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { dateInWib } from '../workflow/engine.js';
import {
  advisorySchema,
  advisoryScore,
  cveSchema,
  dedupeFindings,
  type Finding,
} from './findings.js';

const day = 24 * 60 * 60 * 1000;
const cacheEntry = z.object({
  at: z.number().nonnegative(),
  value: z.unknown(),
});

export class JsonCache {
  private readonly memory = new Map<string, z.infer<typeof cacheEntry>>();
  constructor(
    readonly directory?: string,
    private readonly now = Date.now,
  ) {
    if (directory) mkdirSync(directory, { recursive: true });
  }

  filename(key: string): string {
    if (!this.directory) throw new Error('This cache is memory-only.');
    return join(
      this.directory,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }

  async get<T>(
    key: string,
    schema: z.ZodType<T>,
    load: () => Promise<unknown>,
  ): Promise<T> {
    let cached = this.memory.get(key);
    if (!cached && this.directory) {
      try {
        const parsed = cacheEntry.safeParse(
          JSON.parse(readFileSync(this.filename(key), 'utf8')),
        );
        if (parsed.success) cached = parsed.data;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    if (cached && this.now() >= cached.at && this.now() - cached.at < day) {
      const parsed = schema.safeParse(cached.value);
      if (parsed.success) return parsed.data;
    }
    const value = schema.parse(await load());
    const entry = { at: this.now(), value };
    if (this.directory) {
      const filename = this.filename(key);
      writeFileSync(`${filename}.pending`, JSON.stringify(entry), {
        mode: 0o600,
      });
      renameSync(`${filename}.pending`, filename);
    }
    this.memory.set(key, entry);
    return value;
  }
}

const probability = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .pipe(z.coerce.number<string | number>().min(0).max(1));
const epssRow = z.object({
  cve: cveSchema,
  epss: probability,
  percentile: probability,
  date: z.iso.date(),
});
const epssSchema = z.object({
  status: z.literal('OK'),
  data: z.array(epssRow),
});
const kevSchema = z.object({
  vulnerabilities: z.array(
    z.object({ cveID: cveSchema, dueDate: z.iso.date() }),
  ),
});
const metric = z.array(
  z.object({ cvssData: z.object({ baseScore: z.number().min(0).max(10) }) }),
);
const nvdSchema = z.object({
  vulnerabilities: z.array(
    z.object({
      cve: z.object({
        id: cveSchema,
        metrics: z
          .object({
            cvssMetricV40: metric.optional(),
            cvssMetricV31: metric.optional(),
            cvssMetricV30: metric.optional(),
            cvssMetricV2: metric.optional(),
          })
          .optional(),
      }),
    }),
  ),
});

export const enrichmentSchema = z
  .object({
    cvss: z.number().min(0).max(10).nullable(),
    epss: z.number().min(0).max(1).nullable(),
    epss_percentile: z.number().min(0).max(1).nullable(),
    epss_date: z.iso.date().nullable(),
    kev: z.boolean().nullable(),
    kev_due_date: z.iso.date().nullable(),
    cve_ids: z.array(cveSchema).optional(),
    warnings: z.array(z.string().max(500)),
  })
  .strict();
export type Enrichment = z.infer<typeof enrichmentSchema>;

export function epssBatches(input: string[]): string[][] {
  const cves = [...new Set(z.array(cveSchema).parse(input))].sort();
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const cve of cves) {
    const next = [...batch, cve];
    if (`?cve=${next.join(',')}&limit=${next.length}`.length > 2000) {
      batches.push(batch);
      batch = [cve];
    } else batch = next;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function unavailable(source: string, error: unknown): string {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? ` (HTTP ${error.status})`
      : '';
  return `${source} unavailable${status}; no value was inferred.`;
}

export class Enricher {
  private nextNvdAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  constructor(
    readonly github: Octokit,
    readonly cache: JsonCache,
    readonly options: {
      fetch?: typeof fetch;
      nvd?: { apiKey?: string };
      now?: () => number;
      sleep?: (ms: number) => Promise<unknown>;
    } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
  }

  private async json(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok)
      throw Object.assign(new Error('Enrichment HTTP failure.'), {
        status: response.status,
      });
    const text = await response.text();
    if (text.length > 10 * 1024 * 1024)
      throw new Error('Enrichment response exceeds the size limit.');
    return JSON.parse(text);
  }

  private async nvd(cve: string): Promise<number | null> {
    const result = await this.cache.get(`nvd/${cve}`, nvdSchema, async () => {
      const spacing = this.options.nvd?.apiKey ? 650 : 6500;
      const wait = Math.max(0, this.nextNvdAt - this.now());
      if (wait) await this.sleep(wait);
      this.nextNvdAt = this.now() + spacing;
      const headers: Record<string, string> = this.options.nvd?.apiKey
        ? { apiKey: this.options.nvd.apiKey }
        : {};
      return this.json(
        `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cve}`,
        headers,
      );
    });
    const metrics = result.vulnerabilities.find((entry) => entry.cve.id === cve)
      ?.cve.metrics;
    const scores = Object.values(metrics ?? {}).flatMap((entries) =>
      entries.map((entry) => entry.cvssData.baseScore),
    );
    return scores.length ? Math.max(...scores) : null;
  }

  async enrich(input: Finding[]): Promise<Map<string, Enrichment>> {
    const findings = dedupeFindings(input);
    const resolved = new Map<
      string,
      { cves: string[]; scores: number[]; warnings: string[] }
    >();
    for (const finding of findings) {
      const aliases = new Set(finding.cve_ids);
      const scores = finding.cvss === null ? [] : [finding.cvss];
      const warnings: string[] = [];
      for (const ghsa of finding.ghsa_ids) {
        try {
          const advisory = await this.cache.get(
            `advisory/${ghsa}`,
            advisorySchema,
            async () =>
              (
                await this.github.request('GET /advisories/{ghsa_id}', {
                  ghsa_id: ghsa,
                })
              ).data,
          );
          if (advisory.ghsa_id !== ghsa)
            throw new Error('Advisory identity mismatch.');
          if (advisory.cve_id) aliases.add(advisory.cve_id);
          for (const identifier of advisory.identifiers) {
            if (identifier.type !== 'CVE') continue;
            const cve = cveSchema.safeParse(identifier.value);
            if (cve.success) aliases.add(cve.data);
            else
              warnings.push(
                `GitHub advisory ${ghsa}: invalid CVE alias omitted.`,
              );
          }
          const score = advisoryScore(advisory);
          if (score !== null) scores.push(score);
        } catch (error) {
          warnings.push(unavailable(`GitHub advisory ${ghsa}`, error));
        }
      }
      resolved.set(finding.key, { cves: [...aliases], scores, warnings });
    }
    const cves = [
      ...new Set([...resolved.values()].flatMap((value) => value.cves)),
    ];
    const epss = new Map<string, z.infer<typeof epssRow>>();
    const epssErrors = new Map<string, string>();
    for (const batch of epssBatches(cves)) {
      try {
        const result = await this.cache.get(
          `epss/${batch.join(',')}`,
          epssSchema,
          () =>
            this.json(
              `https://api.first.org/data/v1/epss?cve=${batch.join(',')}&limit=${batch.length}`,
            ),
        );
        for (const row of result.data)
          if (batch.includes(row.cve)) epss.set(row.cve, row);
      } catch (error) {
        for (const cve of batch)
          epssErrors.set(cve, unavailable(`EPSS ${cve}`, error));
      }
    }
    let kev: z.infer<typeof kevSchema> | null = null;
    let kevError = '';
    if (cves.length) {
      try {
        kev = await this.cache.get('cisa-kev', kevSchema, () =>
          this.json(
            'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
          ),
        );
      } catch (error) {
        kevError = unavailable('CISA KEV', error);
      }
    }
    const result = new Map<string, Enrichment>();
    for (const finding of findings) {
      const value = resolved.get(finding.key);
      if (!value) throw new Error('Missing advisory resolution.');
      const { scores, warnings, cves: aliases } = value;
      if (!scores.length && this.options.nvd) {
        for (const cve of aliases) {
          try {
            const score = await this.nvd(cve);
            if (score === null)
              warnings.push(`NVD CVSS ${cve} missing; no value was inferred.`);
            else scores.push(score);
          } catch (error) {
            warnings.push(unavailable(`NVD ${cve}`, error));
          }
        }
      }
      if (!scores.length)
        warnings.push('CVSS unavailable; no score was inferred.');
      for (const cve of aliases) {
        if (!epss.has(cve))
          warnings.push(
            epssErrors.get(cve) ??
              `EPSS ${cve} missing; no score was inferred.`,
          );
      }
      if (!aliases.length)
        warnings.push(
          'No CVE identifier: EPSS and KEV enrichment unavailable.',
        );
      else if (kevError) warnings.push(kevError);
      const rows = aliases
        .flatMap((cve) => epss.get(cve) ?? [])
        .sort((a, b) => b.epss - a.epss);
      const known = kev?.vulnerabilities.filter((row) =>
        aliases.includes(row.cveID),
      );
      result.set(
        finding.key,
        enrichmentSchema.parse({
          cvss: scores.length ? Math.max(...scores) : null,
          epss: rows[0]?.epss ?? null,
          epss_percentile: rows[0]?.percentile ?? null,
          epss_date: rows[0]?.date ?? null,
          kev: known ? known.length > 0 : null,
          kev_due_date: known?.map((row) => row.dueDate).sort()[0] ?? null,
          cve_ids: aliases,
          warnings,
        }),
      );
    }
    return result;
  }
}

export function priorityFor(
  values: Pick<Enrichment, 'cvss' | 'epss' | 'kev'>,
  config: Config,
): 'p1' | 'p2' | 'p3' | 'p4' {
  const { cvss, epss, kev } = enrichmentSchema
    .pick({ cvss: true, epss: true, kev: true })
    .strip()
    .parse(values);
  const p = config.priority;
  if (
    kev === true ||
    (cvss !== null && cvss >= p.p1_cvss) ||
    (epss !== null && epss >= p.p1_epss && cvss !== null && cvss >= p.p2_cvss)
  )
    return 'p1';
  if (
    (cvss !== null && cvss >= p.p2_cvss) ||
    (epss !== null && epss >= p.p2_epss)
  )
    return 'p2';
  return cvss !== null && cvss >= p.p3_cvss ? 'p3' : 'p4';
}

export function slaDueDate(
  firstSeen: string,
  priority: 'p1' | 'p2' | 'p3' | 'p4',
  config: Config,
): string {
  z.iso.datetime({ offset: true }).parse(firstSeen);
  const date = new Date(`${dateInWib(firstSeen)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + config.sla_days[priority]);
  return z.iso.date().parse(date.toISOString().slice(0, 10));
}

export function slaBreached(
  due: string | null,
  at = new Date().toISOString(),
): boolean {
  return due !== null && z.iso.date().parse(due) < dateInWib(at);
}
