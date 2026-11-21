import {
  evidenceSchema,
  expectedState,
  isAuditWriter,
  readAudit,
  readMeta,
  type Config,
  type Issue,
  type IssueComment,
} from '@pronoia/core';
import { itemDetailSchema, type Card, type ItemDetail } from './shared';

function section(body: string, title: string): string {
  return (
    body
      .split(/^## /m)
      .find((entry) => entry.startsWith(`${title}\n`))
      ?.slice(title.length + 1)
      .trim() ?? ''
  );
}

export function buildCard(
  issue: Issue,
  comments: IssueComment[],
  config: Config,
): Card {
  const state = expectedState(issue, comments, config);
  const meta = readMeta(issue.body);
  return {
    number: issue.number,
    updatedAt: issue.updated_at,
    title: issue.title,
    status: state.status,
    severity: state.severity,
    priority: meta?.priority ?? 'p4',
    assessment: meta?.assessment ?? 'Manual',
    body: issue.body,
    url: issue.html_url,
    assignees: issue.assignees.map((actor) => actor.login),
    validationRequestedBy: state.validation_requested_by,
    evidenceCount: state.evidence_count,
  };
}

export function buildItemDetail(
  issue: Issue,
  comments: IssueComment[],
  config: Config,
): ItemDetail {
  const meta = readMeta(issue.body);
  const evidence: ItemDetail['evidence'] = [];
  const trail: ItemDetail['trail'] = [];
  const warnings: string[] = [];
  for (const comment of comments) {
    if (!comment.user) continue;
    const audit = readAudit(comment.body, comment.user.login);
    if (audit)
      trail.push({
        at: audit.at,
        from: audit.from,
        to: audit.to,
        command: `/${audit.command.name}`,
        actor: audit.actor,
        actorType: audit.actor_type,
        onBehalfOf: audit.on_behalf_of,
        reason: audit.failure_reason ?? audit.reason,
        evidenceCount: audit.evidence_count,
      });
    if (
      !isAuditWriter(comment.user.login) &&
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)
    )
      continue;
    const match = /<!-- pronoia:evidence (.*?) -->/s.exec(comment.body);
    if (!match?.[1]) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(match[1]);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      warnings.push(`Invalid evidence metadata in comment ${comment.id}.`);
      continue;
    }
    const parsed = evidenceSchema.safeParse(raw);
    if (
      !parsed.success ||
      !parsed.data.file.startsWith(`evidence/${issue.number}/`)
    ) {
      warnings.push(`Invalid or cross-item evidence in comment ${comment.id}.`);
      continue;
    }
    const record = parsed.data;
    if (
      evidence.some(
        (entry) => entry.file === record.file && entry.sha256 === record.sha256,
      )
    )
      continue;
    evidence.push({
      file: record.file,
      sha256: record.sha256,
      capturedAt: record.captured_at,
      capturedBy: record.captured_by,
      source: record.source,
      session: record.session,
      step: record.step,
      note: record.note,
      url: `https://github.com/${config.board_repo}/blob/evidence/${record.file}?raw=true`,
    });
  }
  return itemDetailSchema.parse({
    card: buildCard(issue, comments, config),
    test: meta?.test_description || section(issue.body, 'Test'),
    procedure: meta?.procedure || section(issue.body, 'Procedure'),
    expected: meta?.expected_result || section(issue.body, 'Expected result'),
    actual: meta?.actual_result || section(issue.body, 'Actual result'),
    remediation: meta?.remediation.length
      ? meta.remediation
      : section(issue.body, 'Remediation')
          .split('\n')
          .map((step) => step.replace(/^[-*]\s*(?:\[[ x]\]\s*)?/, '').trim())
          .filter(Boolean),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      actor: comment.user?.login ?? '[deleted]',
      at: comment.created_at,
      url: comment.html_url,
    })),
    trail,
    evidence,
    warnings,
  });
}
