import type { Octokit } from 'octokit';
import { z } from 'zod';
import { repoSchema } from '../config.js';
import { disputeSchema } from '../workflow/schemas.js';
import {
  ingestDependabot,
  ingestCodeScanning,
  ingestSecretScanning,
  type Finding,
} from './findings.js';

export class SecurityError extends Error {
  constructor(
    readonly code: 'invalid-data' | 'upstream' | 'privacy' | 'config',
    message: string,
  ) {
    super(message);
  }
}
export const alertRefSchema = z
  .object({
    repo: repoSchema,
    source: z.enum(['dependabot', 'code-scanning', 'secret-scanning']),
    number: z.number().int().positive(),
  })
  .strict();
export type AlertRef = z.infer<typeof alertRefSchema>;

export function repositoryScope(repository: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo] = repoSchema.parse(repository).split('/');
  if (!owner || !repo)
    throw new SecurityError('config', 'Invalid target repository.');
  return { owner, repo };
}

function status(error: unknown): number | null {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : null;
}

const ingestors = {
  dependabot: ingestDependabot,
  'code-scanning': ingestCodeScanning,
  'secret-scanning': ingestSecretScanning,
};

export class SecurityAlerts {
  constructor(
    readonly api: Octokit,
    readonly fallbackRepo?: string,
  ) {}

  async access(
    repo: string,
  ): Promise<{ allowed: boolean; warning: string | null }> {
    if (!this.fallbackRepo) return { allowed: true, warning: null };
    try {
      await this.isPrivate(repo);
      return { allowed: true, warning: null };
    } catch (error) {
      const code = status(error);
      if (code === 403 || code === 404)
        return {
          allowed: false,
          warning: `Target metadata ${repo} unavailable (HTTP ${code}); target skipped.`,
        };
      if (!(error instanceof SecurityError) || error.code !== 'config')
        throw error;
      return { allowed: false, warning: `${error.message} Target skipped.` };
    }
  }

  async visibility(
    repo: string,
  ): Promise<{ private: boolean | null; warning: string | null }> {
    const access = await this.access(repo);
    if (!access.allowed) return { private: null, warning: access.warning };
    try {
      return { private: await this.isPrivate(repo), warning: null };
    } catch (error) {
      const code = status(error);
      if (code !== 403 && code !== 404) throw error;
      return {
        private: null,
        warning: `Target metadata ${repo} unavailable (HTTP ${code}); target skipped.`,
      };
    }
  }

  async isPrivate(repo: string): Promise<boolean> {
    if (
      this.fallbackRepo &&
      repo.toLowerCase() !== this.fallbackRepo.toLowerCase()
    )
      throw new SecurityError(
        'config',
        `Separate target READ credential required for ${repo}; board token is not used.`,
      );
    const privateRepo = z
      .object({ private: z.boolean() })
      .parse(
        (await this.api.rest.repos.get(repositoryScope(repo))).data,
      ).private;
    if (this.fallbackRepo && privateRepo)
      throw new SecurityError(
        'config',
        'Own private repository requires a separate target READ credential; board fallback is public-only.',
      );
    return privateRepo;
  }

  async list(
    repo: string,
  ): Promise<{ findings: Finding[]; warnings: string[] }> {
    const access = await this.access(repo);
    if (!access.allowed)
      return { findings: [], warnings: access.warning ? [access.warning] : [] };
    const findings: Finding[] = [];
    const warnings: string[] = [];
    for (const source of alertRefSchema.shape.source.options) {
      try {
        const rows = await this.api.paginate(
          `GET /repos/{owner}/{repo}/${source}/alerts`,
          {
            ...repositoryScope(repo),
            per_page: 100,
            ...(source === 'dependabot'
              ? { state: 'open,fixed,dismissed,auto_dismissed' }
              : {}),
            ...(source === 'secret-scanning' ? { hide_secret: true } : {}),
          },
        );
        findings.push(...ingestors[source](rows, repo));
      } catch (error) {
        const code = status(error);
        if (code === 403 || code === 404)
          warnings.push(
            `${source} ${repo}: disabled, unlicensed or not permitted (HTTP ${code}); skipped.`,
          );
        else
          throw new SecurityError(
            error instanceof z.ZodError ? 'invalid-data' : 'upstream',
            `${source} ${repo}: ${error instanceof z.ZodError ? 'invalid alert schema' : `scan read failed${code ? ` (HTTP ${code})` : ''}`}.`,
          );
      }
    }
    return { findings, warnings };
  }

  async get(
    input: AlertRef,
  ): Promise<{ finding: Finding | null; warning: string | null }> {
    const ref = alertRefSchema.parse(input);
    const access = await this.access(ref.repo);
    if (!access.allowed) return { finding: null, warning: access.warning };
    try {
      const result = await this.api.request(
        `GET /repos/{owner}/{repo}/${ref.source}/alerts/{alert_number}`,
        {
          ...repositoryScope(ref.repo),
          alert_number: ref.number,
          ...(ref.source === 'secret-scanning' ? { hide_secret: true } : {}),
        },
      );
      const finding = ingestors[ref.source]([result.data], ref.repo)[0];
      if (!finding || finding.number !== ref.number)
        throw new SecurityError(
          'invalid-data',
          'Alert identity did not match the request.',
        );
      return { finding, warning: null };
    } catch (error) {
      const code = status(error);
      if (code === 403 || code === 404)
        return {
          finding: null,
          warning: `${ref.source} ${ref.repo} #${ref.number}: unavailable (HTTP ${code}); no fixed proof inferred.`,
        };
      if (error instanceof SecurityError) throw error;
      throw new SecurityError(
        error instanceof z.ZodError ? 'invalid-data' : 'upstream',
        `${ref.source} ${ref.repo} #${ref.number}: ${error instanceof z.ZodError ? 'invalid alert schema' : `read failed${code ? ` (HTTP ${code})` : ''}`}.`,
      );
    }
  }

  async fixed(refs: AlertRef[]): Promise<boolean> {
    if (!refs.length) return false;
    for (const ref of refs)
      if ((await this.get(ref)).finding?.state !== 'fixed') return false;
    return true;
  }
}

export const mergedPrSchema = z.object({
  title: z.string().max(10000),
  body: z.string().max(60000).nullable(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  base: z.object({ repo: z.object({ full_name: repoSchema }) }),
  head: z.object({ repo: z.object({ full_name: repoSchema }).nullable() }),
});

export function mergedReferences(input: unknown, repository: string): number[] {
  const pr = mergedPrSchema.parse(input);
  const repo = repoSchema.parse(repository).toLowerCase();
  if (
    !pr.merged_at ||
    pr.base.repo.full_name.toLowerCase() !== repo ||
    pr.head.repo?.full_name.toLowerCase() !== repo
  )
    return [];
  const numbers = new Set<number>();
  for (const match of `${pr.title}\n${pr.body ?? ''}`.matchAll(
    /\b(?:refs?|fixes|closes):?\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*(?:\s*(?:,|and)\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*)*)/gi,
  )) {
    for (const ref of (match[1] ?? '').matchAll(
      /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)/g,
    )) {
      if (!ref[1] || ref[1].toLowerCase() === repo)
        numbers.add(z.coerce.number().int().positive().safe().parse(ref[2]));
    }
  }
  return [...numbers];
}

export function dismissalParameters(
  source: AlertRef['source'],
  input: z.infer<typeof disputeSchema>,
): Record<string, string> {
  const dispute = disputeSchema.parse(input);
  switch (source) {
    case 'dependabot':
      return {
        state: 'dismissed',
        dismissed_reason:
          dispute === 'false-positive'
            ? 'inaccurate'
            : dispute === 'not-applicable'
              ? 'not_used'
              : 'tolerable_risk',
      };
    case 'code-scanning':
      return {
        state: 'dismissed',
        dismissed_reason:
          dispute === 'false-positive' ? 'false positive' : "won't fix",
      };
    case 'secret-scanning':
      return {
        state: 'resolved',
        resolution:
          dispute === 'false-positive' ? 'false_positive' : 'wont_fix',
      };
  }
}
