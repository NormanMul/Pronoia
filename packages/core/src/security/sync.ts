import type { Octokit } from 'octokit';
import { z } from 'zod';
import type { Board, IssueComment } from '../github.js';
import {
  marker,
  metaSchema,
  readMeta,
  slug,
  type IssueMeta,
} from '../assessment.js';
import { dateInWib, isAuditWriter, readAudit } from '../workflow/engine.js';
import { expectedState } from '../workflow/guards.js';
import type { WorkflowState } from '../workflow/schemas.js';
import {
  alertStateSchema,
  findingSchema,
  dedupeFindings,
  publicationAllowed,
  safeText,
  type Finding,
} from './findings.js';
import {
  Enricher,
  enrichmentSchema,
  priorityFor,
  slaBreached,
  slaDueDate,
  type Enrichment,
} from './enrichment.js';
import {
  SecurityAlerts,
  SecurityError,
  dismissalParameters,
  mergedReferences,
  repositoryScope,
} from './alerts.js';

const observationSchema = z.object({
  key: z.string().max(500),
  state: alertStateSchema,
  source_updated_at: z.iso.datetime({ offset: true }).optional(),
  at: z.iso.datetime({ offset: true }),
  command_ids: z.array(z.number().int().positive()),
});
const snapshotSchema = z.object({
  finding: findingSchema,
  enrichment: enrichmentSchema,
  synthetic: z.boolean(),
});

export function readObservation(
  comments: IssueComment[],
  key: string,
): z.infer<typeof observationSchema> | null {
  let observation: z.infer<typeof observationSchema> | null = null;
  for (const comment of comments) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = /<!-- pronoia:security-observation (.*?) -->/s.exec(
      comment.body,
    );
    if (!match?.[1]) continue;
    const record = observationSchema.parse(JSON.parse(match[1]));
    if (record.key === key) observation = record;
  }
  return observation;
}

function text(value: string): string {
  return safeText(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function findingMeta(
  finding: Finding,
  enrichment: Enrichment,
  assessment: string,
  board: Board,
  previous?: IssueMeta,
  dueOverride?: string | null,
): IssueMeta {
  const firstSeen = previous?.first_seen_at ?? finding.created_at;
  const priority = priorityFor(enrichment, board.config);
  const cveIds = [
    ...new Set([...finding.cve_ids, ...(enrichment.cve_ids ?? [])]),
  ];
  return metaSchema.parse({
    ...previous,
    dedupe_key: finding.key,
    assessment,
    test_id: String(finding.number ?? finding.rule_id ?? 'sarif'),
    source: finding.source,
    category: 'Security',
    evidence_required: true,
    test_description: finding.description,
    expected_result:
      'Verify the source finding is fixed and review the actual remediation.',
    alert_refs:
      finding.source !== 'sarif' && finding.number
        ? [
            {
              repo: finding.repo,
              source: finding.source,
              number: finding.number,
            },
          ]
        : [],
    cve_ids: cveIds,
    cvss: enrichment.cvss,
    epss: enrichment.epss,
    epss_percentile: enrichment.epss_percentile,
    epss_date: enrichment.epss_date,
    kev: enrichment.kev === true,
    kev_due_date: enrichment.kev_due_date,
    priority,
    due_date: dueOverride ?? slaDueDate(firstSeen, priority, board.config),
    first_seen_at: firstSeen,
    finding: { ...finding, cve_ids: cveIds },
    enrichment,
    synthetic: previous?.synthetic ?? true,
  });
}

function findingSection(finding: Finding): string {
  return `## Security finding\nSource: **${finding.source}**, alert: ${finding.number ?? 'SARIF fingerprint'}.\n\n${text(finding.description)}\n\nRule: ${text(finding.rule_id ?? finding.ghsa_ids.join(', ')) || 'not supplied'}.\nRepository-relative path: ${finding.path ? `\`${text(finding.path)}\`` : 'omitted/not supplied'}.\n[Source metadata](${finding.link}). No source snippets or secret values are published.`;
}

function prioritySection(meta: IssueMeta): string {
  return `## Priority and SLA\nPriority: **${meta.priority.toUpperCase()}**. CVSS: ${meta.cvss ?? 'unavailable'}; EPSS: ${meta.epss ?? 'unavailable'}; KEV: ${meta.enrichment?.kev === null ? 'unavailable' : meta.kev ? 'listed' : 'not listed'}.\nFirst seen: ${meta.first_seen_at ?? 'unavailable'}. Due: **${meta.due_date ?? 'unavailable'}** (WIB).\n${meta.enrichment?.warnings.map((warning) => `- Warning: ${text(warning)}`).join('\n') ?? ''}`;
}

function section(body: string, heading: string, replacement: string): string {
  const regex = new RegExp(`## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`);
  return regex.test(body)
    ? body.replace(regex, () => `${replacement}\n`)
    : `${body}\n\n${replacement}`;
}

export async function importSecurityFindings(
  board: Board,
  findings: Finding[],
  enricher: Enricher,
  assessment: string,
  options: { synthetic?: boolean; targetPrivate?: boolean } = {},
): Promise<{ issues: number[]; created: number; warnings: string[] }> {
  const normalized = dedupeFindings(findings);
  const publicBoard = await board.isPublic();
  for (const finding of normalized) {
    if (publicBoard && finding.source === 'sarif' && options.synthetic !== true)
      throw new SecurityError(
        'privacy',
        'Public SARIF imports require explicitly attested synthetic data.',
      );
    if (
      !publicationAllowed(
        publicBoard,
        options.targetPrivate ?? false,
        finding.repo,
        board.config.board_repo,
        options.synthetic === true,
      )
    )
      throw new SecurityError(
        'privacy',
        'Public board rejects private targets and real engagement data. Explicitly attest a public synthetic target.',
      );
  }
  const existing = new Map<string, number>();
  for (const issue of await board.issues()) {
    const key = readMeta(issue.body)?.dedupe_key;
    if (key) {
      if (existing.has(key))
        throw new SecurityError(
          'invalid-data',
          'Duplicate board dedupe keys must be resolved before sync.',
        );
      existing.set(key, issue.number);
    }
  }
  const enrichment = await enricher.enrich(normalized);
  if (normalized.length)
    await board.setupLabels([`assessment:${slug(assessment)}`]);
  const issues: number[] = [];
  const warnings: string[] = [];
  let created = 0;
  for (const finding of normalized) {
    const values = enrichment.get(finding.key);
    if (!values)
      throw new SecurityError(
        'invalid-data',
        'Missing validated enrichment result.',
      );
    warnings.push(...values.warnings);
    const found = existing.get(finding.key);
    if (found) {
      if (finding.source === 'sarif') {
        await board.comment(
          found,
          `Validated synthetic/private SARIF snapshot queued for the per-issue worker; no status written by ingestion.\n\n${marker('sarif-snapshot', { finding, enrichment: values, synthetic: options.synthetic === true })}`,
        );
      }
      issues.push(found);
      continue;
    }
    const meta = findingMeta(finding, values, assessment, board);
    meta.synthetic =
      options.synthetic === true ||
      (finding.repo.toLowerCase() === board.config.board_repo.toLowerCase() &&
        !options.targetPrivate);
    const body = [
      marker('meta', meta),
      findingSection(finding),
      prioritySection(meta),
      '## Expected result\nSource finding fixed; independent review with evidence.',
      `## Actual result\nSource state: ${finding.state}. Not yet independently reviewed.`,
      '## Evidence\nSource metadata is not human approval. A merged PR plus a live verified fixed alert can satisfy the automated-finding evidence rule.',
      `## Remediation\n${finding.first_patched_version ? `Review an upgrade to ${text(finding.first_patched_version)} and add regression tests.` : 'Review the source advisory/rule and add a focused regression test.'}`,
      '## Validation trail\nPost first-line commands; a different, uninvolved human must approve.',
    ].join('\n\n');
    const result = z.object({ number: z.number().int().positive() }).parse(
      (
        await board.api.rest.issues.create({
          ...board.scope,
          title: finding.title,
          body,
          labels: [
            'pronoia',
            'status:todo',
            `severity:${finding.severity}`,
            `source:${finding.source}`,
            `assessment:${slug(assessment)}`,
            `priority:${meta.priority}`,
            ...(meta.kev ? ['kev'] : []),
            ...(slaBreached(meta.due_date) ? ['sla:breached'] : []),
          ],
        })
      ).data,
    );
    existing.set(finding.key, result.number);
    issues.push(result.number);
    created += 1;
  }
  return {
    issues: [...new Set(issues)],
    created,
    warnings: [...new Set(warnings)],
  };
}

export async function discoverSecurity(
  board: Board,
  alerts: SecurityAlerts,
  enricher: Enricher,
  options: { synthetic?: boolean } = {},
): Promise<{ issues: number[]; created: number; warnings: string[] }> {
  const targets = board.config.targets.length
    ? board.config.targets
    : [
        {
          repo: board.config.board_repo,
          assessment: 'Code Security - Synthetic dogfood',
          synthetic: true,
        },
      ];
  const issues = new Set((await board.issues()).map((issue) => issue.number));
  const warnings: string[] = [];
  let created = 0;
  for (const target of targets) {
    const synthetic = options.synthetic === true || target.synthetic;
    const visibility = await alerts.visibility(target.repo);
    if (visibility.private === null) {
      if (visibility.warning) warnings.push(visibility.warning);
      continue;
    }
    const targetPrivate = visibility.private;
    if (
      !publicationAllowed(
        await board.isPublic(),
        targetPrivate,
        target.repo,
        board.config.board_repo,
        synthetic,
      )
    )
      throw new SecurityError(
        'privacy',
        'Public board cannot ingest private or unconfirmed real targets.',
      );
    const scan = await alerts.list(target.repo);
    warnings.push(...scan.warnings);
    const result = await importSecurityFindings(
      board,
      scan.findings,
      enricher,
      target.assessment,
      { synthetic, targetPrivate },
    );
    result.issues.forEach((issue) => issues.add(issue));
    warnings.push(...result.warnings);
    created += result.created;
  }
  return { issues: [...issues], created, warnings: [...new Set(warnings)] };
}

export function securityCommand(
  state: WorkflowState,
  current: Pick<Finding, 'state' | 'updated_at'> | null,
  previous: Finding['state'] | null,
  at: string,
): string | null {
  z.iso.datetime({ offset: true }).parse(at);
  if (
    state.status === 'done' &&
    state.resolution === 'risk-accepted' &&
    state.risk_until &&
    state.risk_until < dateInWib(at)
  )
    return `/reopen Risk acceptance expired after ${state.risk_until} WIB (until is inclusive).`;
  if (!current) return null;
  if (
    state.status === 'done' &&
    current.state === 'open' &&
    ((previous !== null && previous !== 'open') ||
      (state.resolution === 'fixed' && state.alert_fixed))
  )
    return '/reopen Source alert reappeared; live alert state verified open.';
  if (
    ['todo', 'in-progress', 'blocked'].includes(state.status) &&
    current.state !== 'open'
  )
    return `/validate Source alert ${current.state}; live state verified. Independent human review still required.`;
  return null;
}

async function queue(
  board: Board,
  issue: number,
  body: string,
  event: string,
  details: Record<string, unknown> = {},
): Promise<number> {
  for (const comment of await board.comments(issue)) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = /<!-- pronoia:internal-command (.*?) -->/s.exec(comment.body);
    if (
      match?.[1] &&
      z.object({ event: z.string() }).parse(JSON.parse(match[1])).event ===
        event
    )
      return comment.id;
  }
  const comment = await board.comment(
    issue,
    `${body}\n\n${marker('internal-command', { event, ...details })}`,
  );
  if (!comment.user || !isAuditWriter(comment.user.login))
    throw new SecurityError(
      'config',
      'Internal commands must be authored by the authoritative Actions token.',
    );
  return comment.id;
}

function targetAllowed(board: Board, repository: string): boolean {
  const targets = board.config.targets.length
    ? board.config.targets.map((target) => target.repo)
    : [board.config.board_repo];
  return targets.some(
    (repo) => repo.toLowerCase() === repository.toLowerCase(),
  );
}

export async function syncSecurityIssue(
  board: Board,
  alerts: SecurityAlerts,
  enricher: Enricher,
  number: number,
  options: { at?: string; dismissApi?: Octokit; synthetic?: boolean } = {},
): Promise<{
  issue: number;
  command_ids: number[];
  observation_id: number | null;
  warnings: string[];
}> {
  // Recovery precedes overlaying fresh scanner metadata or live assignees.
  await board.applyCommands(number);
  let issue = await board.issue(number);
  let comments = await board.comments(number);
  const state = expectedState(issue, comments, board.config);
  const original = readMeta(issue.body);
  const result = {
    issue: number,
    command_ids: [] as number[],
    observation_id: null as number | null,
    warnings: [] as string[],
  };
  if (!original || !issue.labels.includes('pronoia') || issue.pull_request)
    return result;
  const at = options.at ?? new Date().toISOString();
  let finding = original.finding ?? null;
  let refreshed: IssueMeta | null = null;
  if (finding && finding.source !== 'sarif' && finding.number) {
    if (!targetAllowed(board, finding.repo))
      throw new SecurityError(
        'config',
        'Finding repository is not a configured target.',
      );
    const visibility = await alerts.visibility(finding.repo);
    if (visibility.private === null) {
      if (visibility.warning) result.warnings.push(visibility.warning);
      finding = null;
    } else {
      const privateTarget = visibility.private;
      if (
        !publicationAllowed(
          await board.isPublic(),
          privateTarget,
          finding.repo,
          board.config.board_repo,
          original.synthetic && options.synthetic !== false,
        )
      )
        throw new SecurityError(
          'privacy',
          'Private or real target data cannot be synchronized to a public board.',
        );
      const read = await alerts.get({
        repo: finding.repo,
        source: finding.source,
        number: finding.number,
      });
      finding = read.finding;
      if (read.warning) result.warnings.push(read.warning);
      if (finding && finding.key !== original.dedupe_key)
        throw new SecurityError(
          'invalid-data',
          'Source finding identity changed; no board data overwritten.',
        );
    }
  } else if (finding?.source === 'sarif') {
    for (const comment of comments) {
      if (!comment.user || !isAuditWriter(comment.user.login)) continue;
      const match = /<!-- pronoia:sarif-snapshot (.*?) -->/s.exec(comment.body);
      if (!match?.[1]) continue;
      const snapshot = snapshotSchema.parse(JSON.parse(match[1]));
      if (snapshot.finding.key === original.dedupe_key) {
        if ((await board.isPublic()) && !snapshot.synthetic)
          throw new SecurityError(
            'privacy',
            'Public SARIF worker rejects non-synthetic snapshots.',
          );
        finding = snapshot.finding;
      }
    }
  }
  const previous = readObservation(comments, original.dedupe_key);
  let command = securityCommand(state, finding, previous?.state ?? null, at);
  if (command?.startsWith('/validate') && finding?.source === 'sarif')
    command = command.replace(
      'live state verified',
      'validated SARIF snapshot observed (not live alert proof)',
    );
  if (finding) {
    const enrichment = (await enricher.enrich([finding])).get(finding.key);
    if (!enrichment)
      throw new SecurityError('invalid-data', 'Missing validated enrichment.');
    const hasManualDue = comments.some(
      (comment) =>
        comment.user &&
        readAudit(comment.body, comment.user.login)?.command.name === 'due',
    );
    const meta = findingMeta(
      finding,
      enrichment,
      original.assessment,
      board,
      original,
      hasManualDue ? state.due_date : null,
    );
    refreshed = meta;
    let body = issue.body.replace(/<!-- pronoia:meta .*? -->/s, () =>
      marker('meta', meta),
    );
    body = section(body, 'Security finding', findingSection(finding));
    body = section(body, 'Priority and SLA', prioritySection(meta));
    await board.api.rest.issues.update({
      ...board.scope,
      issue_number: number,
      body,
    });
    result.warnings.push(...enrichment.warnings);
  }
  if (command) {
    const event =
      command.startsWith('/reopen') &&
      state.risk_until &&
      state.risk_until < dateInWib(at)
        ? `risk-expiry/${number}/${state.risk_until}`
        : `source/${original.dedupe_key}/${finding?.state}/${finding?.updated_at}/${state.status}`;
    const id = await queue(board, number, command, event, {
      source: original.dedupe_key,
      source_state: finding?.state ?? null,
    });
    result.command_ids.push(id);
    await board.applyCommands(number);
    issue = await board.issue(number);
    comments = await board.comments(number);
  }
  const latest = expectedState(issue, comments, board.config);
  if (
    board.config.auto_dismiss &&
    latest.status === 'done' &&
    finding?.state === 'open' &&
    latest.resolution &&
    latest.resolution !== 'fixed' &&
    !command?.includes('expired')
  ) {
    const approval = comments
      .flatMap((comment) => {
        const audit = comment.user
          ? readAudit(comment.body, comment.user.login)
          : null;
        return audit?.command.name === 'approve' &&
          audit.actor_type === 'human' &&
          audit.state.status === 'done' &&
          audit.state.resolution === latest.resolution &&
          audit.state.dispute_type === latest.resolution &&
          audit.state.disputed_by &&
          audit.state.dispute_reason &&
          audit.state.validated_by === audit.actor &&
          audit.state.validated_at === latest.validated_at
          ? [{ audit, comment }]
          : [];
      })
      .at(-1);
    if (approval && finding.source !== 'sarif' && finding.number) {
      if (!options.dismissApi)
        result.warnings.push(
          'Auto-dismiss requested but the separate optional-dismiss target token is unavailable; source left open.',
        );
      else {
        const parameters = dismissalParameters(
          finding.source,
          latest.resolution,
        );
        await options.dismissApi.request(
          `PATCH /repos/{owner}/{repo}/${finding.source}/alerts/{alert_number}`,
          {
            ...repositoryScope(finding.repo),
            alert_number: finding.number,
            ...parameters,
            ...(finding.source === 'secret-scanning'
              ? {
                  resolution_comment: `Approved dispute on ${board.config.board_repo} #${number}; audited comment ${approval.comment.id}.`,
                }
              : {
                  dismissed_comment: `Approved dispute on ${board.config.board_repo} #${number}; audited comment ${approval.comment.id}.`,
                }),
          },
        );
        await board.comment(
          number,
          `Source dismissal requested after audited human dispute approval.\n\n${marker('source-dismissal', { source: finding.key, approval_command_id: approval.audit.comment_id, approval_audit_id: approval.comment.id, reason: parameters })}`,
        );
        const verified = await alerts.get({
          repo: finding.repo,
          source: finding.source,
          number: finding.number,
        });
        if (verified.finding) finding = verified.finding;
        if (verified.warning) result.warnings.push(verified.warning);
      }
    }
  }
  if (
    finding &&
    (!previous ||
      previous.state !== finding.state ||
      previous.source_updated_at !== finding.updated_at ||
      result.command_ids.length)
  ) {
    const comment = await board.comment(
      number,
      `Source state observed: ${finding.state}. This observation never substitutes for live approval proof.\n\n${marker('security-observation', { key: finding.key, state: finding.state, source_updated_at: finding.updated_at, at, command_ids: result.command_ids })}`,
    );
    result.observation_id = comment.id;
  }
  if (refreshed && finding) {
    issue = await board.issue(number);
    comments = await board.comments(number);
    const final = expectedState(issue, comments, board.config);
    const manualSeverity = comments.some(
      (comment) =>
        comment.user &&
        readAudit(comment.body, comment.user.login)?.command.name ===
          'severity',
    );
    const breachAt =
      final.status === 'done' && final.validated_at ? final.validated_at : at;
    await board.api.rest.issues.setLabels({
      ...board.scope,
      issue_number: number,
      labels: [
        ...issue.labels.filter(
          (label) =>
            !label.startsWith('priority:') &&
            !['kev', 'sla:breached'].includes(label) &&
            (manualSeverity || !label.startsWith('severity:')),
        ),
        ...(manualSeverity ? [] : [`severity:${finding.severity}`]),
        `priority:${refreshed.priority}`,
        ...(refreshed.kev ? ['kev'] : []),
        ...(slaBreached(refreshed.due_date, breachAt) ? ['sla:breached'] : []),
      ],
    });
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}

export async function verifyOnMerge(
  board: Board,
  alerts: SecurityAlerts,
  pull: number,
  number: number,
): Promise<{
  issue: number;
  command_id: number | null;
  proof_comment_id: number | null;
  alert_fixed: boolean;
}> {
  await board.applyCommands(number);
  const pr = (
    await board.api.rest.pulls.get({
      ...board.scope,
      pull_number: z.number().int().positive().parse(pull),
    })
  ).data;
  if (!mergedReferences(pr, board.config.board_repo).includes(number))
    return {
      issue: number,
      command_id: null,
      proof_comment_id: null,
      alert_fixed: false,
    };
  const issue = await board.issue(number);
  const comments = await board.comments(number);
  const state = expectedState(issue, comments, board.config);
  if (!issue.labels.includes('pronoia') || issue.pull_request)
    return {
      issue: number,
      command_id: null,
      proof_comment_id: null,
      alert_fixed: false,
    };
  const meta = readMeta(issue.body);
  const refs = meta?.alert_refs ?? [];
  if (refs.some((ref) => !targetAllowed(board, ref.repo)))
    throw new SecurityError(
      'config',
      'Linked alert is outside configured targets.',
    );
  const fixed = await alerts.fixed(refs);
  let proofId: number | null = null;
  for (const comment of comments) {
    if (!comment.user || !isAuditWriter(comment.user.login)) continue;
    const match = /<!-- pronoia:merge-proof (.*?) -->/s.exec(comment.body);
    if (match?.[1]) {
      const record = z
        .object({
          pull: z.number().int().positive(),
          issue: z.number().int().positive(),
        })
        .parse(JSON.parse(match[1]));
      if (record.pull === pull && record.issue === number) proofId = comment.id;
    }
  }
  if (!proofId)
    proofId = (
      await board.comment(
        number,
        `Merged PR https://github.com/${board.config.board_repo}/pull/${pull} verified from the GitHub API. Fixed alert observed: ${fixed}. Approval always rechecks the PR and live alerts.\n\n${marker('merge-proof', { pull, issue: number, alert_fixed_observed: fixed, at: new Date().toISOString() })}`,
      )
    ).id;
  if (!['todo', 'in-progress', 'blocked'].includes(state.status))
    return {
      issue: number,
      command_id: null,
      proof_comment_id: proofId,
      alert_fixed: fixed,
    };
  const command = await queue(
    board,
    number,
    `/validate Merged PR https://github.com/${board.config.board_repo}/pull/${pull} verified.${fixed ? ' Linked source alerts verified fixed.' : ' Fixed-alert proof unavailable; normal evidence remains required.'}`,
    `merge/${pull}/${number}`,
    { pull, alert_fixed_observed: fixed },
  );
  await board.applyCommands(number);
  return {
    issue: number,
    command_id: command,
    proof_comment_id: proofId,
    alert_fixed: fixed,
  };
}
