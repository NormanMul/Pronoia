import { z } from 'zod';
import { parseCsv } from './csv.js';
import { repoSchema } from './config.js';
import { severitySchema, sourceSchema } from './workflow/schemas.js';

export const assessmentColumns = [
  'test_id',
  'category',
  'title',
  'description',
  'procedure',
  'expected_result',
  'severity',
  'evidence_required',
  'owner_role',
  'references',
] as const;

const rowSchema = z.object({
  test_id: z.string().min(1).max(100),
  category: z.string().max(200),
  title: z.string().min(1).max(256),
  description: z.string().max(10000),
  procedure: z.string().max(10000),
  expected_result: z.string().max(10000),
  severity: severitySchema,
  evidence_required: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true'),
  owner_role: z.string().max(200),
  references: z.string().max(2000),
});
export type AssessmentRow = z.infer<typeof rowSchema>;

export const metaSchema = z.object({
  dedupe_key: z.string().min(1).max(500),
  assessment: z.string().min(1).max(200),
  test_id: z.string().max(200),
  source: sourceSchema,
  category: z.string().default(''),
  milestone: z.string().default(''),
  evidence_required: z.boolean().default(true),
  owner_role: z.string().default(''),
  test_description: z.string().default(''),
  procedure: z.string().default(''),
  expected_result: z.string().default(''),
  actual_result: z.string().default(''),
  remediation: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  alert_refs: z
    .array(
      z.object({
        repo: repoSchema,
        source: z.enum(['dependabot', 'code-scanning', 'secret-scanning']),
        number: z.number().int().positive(),
      }),
    )
    .default([]),
  cve_ids: z.array(z.string()).default([]),
  cvss: z.number().min(0).max(10).nullable().default(null),
  epss: z.number().min(0).max(1).nullable().default(null),
  epss_percentile: z.number().min(0).max(1).nullable().default(null),
  epss_date: z.iso.date().nullable().default(null),
  kev: z.boolean().default(false),
  kev_due_date: z.iso.date().nullable().default(null),
  priority: z.enum(['p1', 'p2', 'p3', 'p4']).default('p4'),
  due_date: z.iso.date().nullable().default(null),
  synthetic: z.boolean().default(false),
});
export type IssueMeta = z.infer<typeof metaSchema>;

export function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 39)
    .replace(/-$/g, '');
  if (!result) throw new Error('An assessment needs a nonempty ASCII slug.');
  return result;
}

export function marker(name: string, value: unknown): string {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid marker name.');
  const json = JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return `<!-- pronoia:${name} ${json} -->`;
}

export function readMeta(body: string): IssueMeta | null {
  const matches = [...body.matchAll(/<!-- pronoia:meta (.*?) -->/gs)];
  if (matches.length > 1) throw new Error('Duplicate Pronoia metadata.');
  if (!matches.length) {
    if (body.includes('pronoia:meta'))
      throw new Error('Malformed Pronoia metadata.');
    return null;
  }
  const json = matches[0]?.[1];
  if (!json) throw new Error('Missing Pronoia metadata JSON.');
  return metaSchema.parse(JSON.parse(json));
}

export function assessmentRows(csv: string): AssessmentRow[] {
  const [headers, ...rows] = parseCsv(csv);
  if (
    !headers ||
    headers.length !== assessmentColumns.length ||
    assessmentColumns.some((column) => !headers.includes(column)) ||
    new Set(headers).size !== headers.length
  ) {
    throw new Error(`CSV header must contain: ${assessmentColumns.join(',')}.`);
  }
  const seen = new Set<string>();
  return rows
    .filter((row) => row.some((value) => value !== ''))
    .map((values, index) => {
      if (values.length !== headers.length)
        throw new Error(`CSV row ${index + 2} has the wrong width.`);
      const row = rowSchema.parse(
        Object.fromEntries(headers.map((name, i) => [name, values[i]])),
      );
      if (seen.has(row.test_id))
        throw new Error(`Duplicate test_id: ${row.test_id}.`);
      seen.add(row.test_id);
      return row;
    });
}

export function issueBody(
  row: AssessmentRow,
  assessment: string,
  synthetic = false,
): string {
  const meta = metaSchema.parse({
    dedupe_key: `checklist/${slug(assessment)}/${row.test_id}`,
    assessment,
    test_id: row.test_id,
    source: 'checklist',
    category: row.category,
    evidence_required: row.evidence_required,
    owner_role: row.owner_role,
    test_description: row.description,
    procedure: row.procedure,
    expected_result: row.expected_result,
    references: row.references ? row.references.split(/\s*;\s*/) : [],
    synthetic,
  });
  const text = (value: string) =>
    value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return [
    marker('meta', meta),
    `## Test\n${text(row.description)}`,
    `## Procedure\n${text(row.procedure)}`,
    `## Expected result\n${text(row.expected_result)}`,
    '## Actual result\nNot yet tested.',
    '## Evidence\nNo evidence published.',
    '## Remediation\nPending assessment.',
    '## Validation trail\nPost a first-line command. A different human must approve.',
  ].join('\n\n');
}
