import { createHash } from 'node:crypto';
import { Octokit } from 'octokit';
import { z } from 'zod';
import type { Config } from './config.js';
import { repoSchema } from './config.js';
import {
  evidencePath,
  evidenceSchema,
  validatePng,
  EvidenceError,
} from './evidence.js';
import {
  issueBody,
  marker,
  readMeta,
  slug,
  type AssessmentRow,
} from './assessment.js';
import {
  actorType,
  allowedCommands,
  authorize,
  isAuditWriter,
  CommandError,
  nextState,
  parseAgentMarker,
  parseCommand,
  readAudit,
} from './workflow/engine.js';
import { expectedState, guardPlan } from './workflow/guards.js';
import {
  sourceSchema,
  statusSchema,
  severitySchema,
  type Actor,
  type Audit,
  type Command,
  type WorkflowState,
} from './workflow/schemas.js';

const userSchema = z.object({
  login: z.string().min(1),
  type: z.enum(['User', 'Bot']).default('User'),
});
export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z
    .string()
    .nullable()
    .transform((body) => body ?? ''),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string() })]))
    .transform((labels) =>
      labels.map((label) => (typeof label === 'string' ? label : label.name)),
    ),
  assignees: z.array(userSchema).default([]),
  state: z.enum(['open', 'closed']),
  html_url: z.url(),
  created_at: z.string(),
  updated_at: z.string(),
  milestone: z.object({ title: z.string() }).nullable().optional(),
  pull_request: z.object({ url: z.string() }).optional(),
});
export const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  user: userSchema.nullable(),
  author_association: z.string(),
  created_at: z.string(),
  html_url: z.url(),
});
export type Issue = z.infer<typeof issueSchema>;
export type IssueComment = z.infer<typeof commentSchema>;

function httpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === status
  );
}

export class Board {
  readonly scope: { owner: string; repo: string };
  constructor(
    readonly api: Octokit,
    readonly config: Config,
  ) {
    const [owner, repo] = repoSchema.parse(config.board_repo).split('/');
    if (!owner || !repo) throw new Error('Invalid board repository.');
    this.scope = { owner, repo };
  }

  async issues(): Promise<Issue[]> {
    const rows = await this.api.paginate(this.api.rest.issues.listForRepo, {
      ...this.scope,
      state: 'all',
      labels: 'pronoia',
      per_page: 100,
    });
    return z
      .array(issueSchema)
      .parse(rows)
      .filter((issue) => !issue.pull_request);
  }

  async issue(number: number): Promise<Issue> {
    z.number().int().positive().parse(number);
    return issueSchema.parse(
      (
        await this.api.rest.issues.get({
          ...this.scope,
          issue_number: number,
        })
      ).data,
    );
  }

  async comments(number: number): Promise<IssueComment[]> {
    return z.array(commentSchema).parse(
      await this.api.paginate(this.api.rest.issues.listComments, {
        ...this.scope,
        issue_number: number,
        per_page: 100,
      }),
    );
  }

  async isPublic(): Promise<boolean> {
    return (
      z
        .object({ private: z.boolean() })
        .parse((await this.api.rest.repos.get(this.scope)).data).private ===
      false
    );
  }

  async setupLabels(extra: string[] = []): Promise<void> {
    const names = [
      'pronoia',
      ...statusSchema.options.map((value) => `status:${value}`),
      ...severitySchema.options.map((value) => `severity:${value}`),
      ...sourceSchema.options.map((value) => `source:${value}`),
      ...['p1', 'p2', 'p3', 'p4'].map((value) => `priority:${value}`),
      ...['false-positive', 'not-applicable', 'risk-accepted'].map(
        (value) => `dispute:${value}`,
      ),
      ...['fixed', 'false-positive', 'not-applicable', 'risk-accepted'].map(
        (value) => `resolution:${value}`,
      ),
      'triage:confirmed',
      'agent:ok',
      'agent:copilot',
      'agent:scout',
      'kev',
      'sla:breached',
      ...extra,
    ];
    const existing = new Set(
      (
        await this.api.paginate(this.api.rest.issues.listLabelsForRepo, {
          ...this.scope,
          per_page: 100,
        })
      ).map((label) => label.name),
    );
    for (const name of new Set(names)) {
      z.string().min(1).max(50).parse(name);
      if (existing.has(name)) continue;
      const color =
        name.includes('critical') ||
        name.includes('blocked') ||
        name === 'priority:p1'
          ? 'b60205'
          : name.includes('done')
            ? '0e8a16'
            : name.includes('validate')
              ? 'fbca04'
              : '1d76db';
      try {
        await this.api.rest.issues.createLabel({ ...this.scope, name, color });
      } catch (error) {
        if (!httpStatus(error, 422)) throw error;
        await this.api.rest.issues.getLabel({ ...this.scope, name });
      }
    }
  }

  async importAssessment(
    rows: AssessmentRow[],
    assessment: string,
    options: { dryRun?: boolean; synthetic?: boolean; milestone?: string },
  ): Promise<{ created: number; planned: number }> {
    const milestoneTitle = options.milestone || assessment;
    const bodies = rows.map((row) => {
      const body = issueBody(row, assessment, options.synthetic);
      const meta = readMeta(body);
      if (!meta) throw new Error('Missing validated assessment metadata.');
      return body.replace(/<!-- pronoia:meta .*? -->/s, () =>
        marker('meta', { ...meta, milestone: milestoneTitle }),
      );
    });
    if (options.dryRun) return { created: 0, planned: rows.length };
    if ((await this.isPublic()) && !options.synthetic) {
      throw new Error(
        'Public board: only explicitly confirmed synthetic data may be imported.',
      );
    }
    const existing = new Set(
      (await this.issues()).map((issue) => readMeta(issue.body)?.dedupe_key),
    );
    await this.setupLabels([`assessment:${slug(assessment)}`]);
    const milestones = await this.api.paginate(
      this.api.rest.issues.listMilestones,
      { ...this.scope, state: 'all', per_page: 100 },
    );
    const found = milestones.find((item) => item.title === milestoneTitle);
    const milestone = z
      .number()
      .int()
      .positive()
      .parse(
        found?.number ??
          (
            await this.api.rest.issues.createMilestone({
              ...this.scope,
              title: milestoneTitle,
            })
          ).data.number,
      );
    let created = 0;
    for (const [index, row] of rows.entries()) {
      const body = bodies[index];
      if (!body) throw new Error('Missing validated issue body.');
      const key = readMeta(body)?.dedupe_key;
      if (existing.has(key)) continue;
      await this.api.rest.issues.create({
        ...this.scope,
        title: row.title,
        body,
        milestone,
        labels: [
          'pronoia',
          'status:todo',
          `severity:${row.severity}`,
          `assessment:${slug(assessment)}`,
          'source:checklist',
        ],
      });
      existing.add(key);
      created += 1;
    }
    return { created, planned: rows.length };
  }

  async comment(
    number: number,
    body: string,
    agent?: string,
  ): Promise<IssueComment> {
    z.number().int().positive().parse(number);
    z.string().min(1).max(60000).parse(body);
    const embeddedAgent = parseAgentMarker(body);
    if (agent && embeddedAgent && agent !== embeddedAgent) {
      throw new CommandError('Conflicting agent identities.');
    }
    const effectiveAgent = agent || embeddedAgent;
    if (effectiveAgent) {
      z.string()
        .regex(/^[A-Za-z0-9_-]{1,60}$/)
        .parse(effectiveAgent);
      const command = parseCommand(body);
      if (
        command &&
        !['start', 'validate', 'block', 'reopen'].includes(command.name)
      ) {
        throw new CommandError(
          'Agents may only start, validate, block or reopen.',
        );
      }
      if (!embeddedAgent)
        body += `\n\n${marker('agent', { agent: effectiveAgent })}`;
    }
    z.string().max(60000).parse(body);
    return commentSchema.parse(
      (
        await this.api.rest.issues.createComment({
          ...this.scope,
          issue_number: number,
          body,
        })
      ).data,
    );
  }

  async evidenceFiles(
    number: number,
  ): Promise<{ path: string; sha: string }[]> {
    try {
      const tree = (
        await this.api.rest.git.getTree({
          ...this.scope,
          tree_sha: 'evidence',
          recursive: '1',
        })
      ).data;
      if (tree.truncated)
        throw new Error(
          'Evidence tree is truncated; use a smaller engagement repository.',
        );
      return tree.tree
        .filter(
          (entry) =>
            entry.type === 'blob' &&
            entry.path?.startsWith(`evidence/${number}/`) &&
            entry.path.endsWith('.png'),
        )
        .map((entry) =>
          z.object({ path: z.string(), sha: z.string() }).parse(entry),
        );
    } catch (error) {
      if (httpStatus(error, 404)) return [];
      throw error;
    }
  }

  async addEvidence(
    number: number,
    png: Buffer,
    details: {
      note: string;
      source: string;
      session?: string;
      step?: string;
      reviewed: boolean;
      synthetic: boolean;
    },
    agent?: string,
  ): Promise<z.infer<typeof evidenceSchema>> {
    if (!details.reviewed)
      throw new Error('Review/redact the image before publishing evidence.');
    if ((await this.isPublic()) && !details.synthetic) {
      throw new Error(
        'Public evidence branch: synthetic demonstration screenshots only.',
      );
    }
    const issue = await this.issue(number);
    if (!issue.labels.includes('pronoia') || issue.pull_request) {
      throw new Error('Evidence must belong to a Pronoia issue.');
    }
    const captured_at = new Date().toISOString();
    const file = evidencePath(number, png, captured_at);
    const user = userSchema.parse(
      (await this.api.rest.users.getAuthenticated()).data,
    );
    const meta = evidenceSchema.parse({
      file,
      sha256: createHash('sha256').update(png).digest('hex'),
      captured_at,
      captured_by: agent ? `${user.login} (${agent})` : user.login,
      source: details.source,
      session: details.session,
      step: details.step,
      note: details.note,
    });
    try {
      await this.api.rest.git.getRef({ ...this.scope, ref: 'heads/evidence' });
    } catch (error) {
      if (!httpStatus(error, 404)) throw error;
      const tree = (
        await this.api.rest.git.createTree({
          ...this.scope,
          tree: [
            {
              path: '.gitkeep',
              mode: '100644',
              type: 'blob',
              content: 'Synthetic evidence only in public repositories.\n',
            },
          ],
        })
      ).data;
      const commit = (
        await this.api.rest.git.createCommit({
          ...this.scope,
          message: 'chore: initialize evidence branch [skip ci]',
          tree: tree.sha,
          parents: [],
        })
      ).data;
      try {
        await this.api.rest.git.createRef({
          ...this.scope,
          ref: 'refs/heads/evidence',
          sha: commit.sha,
        });
      } catch (error) {
        if (!httpStatus(error, 422)) throw error;
        await this.api.rest.git.getRef({
          ...this.scope,
          ref: 'heads/evidence',
        });
      }
    }
    let existing: Buffer | undefined;
    try {
      existing = await this.readEvidence(file);
    } catch (error) {
      if (!httpStatus(error, 404)) throw error;
    }
    if (existing) {
      if (createHash('sha256').update(existing).digest('hex') !== meta.sha256) {
        throw new Error(
          'Evidence filename collision; existing content was not overwritten.',
        );
      }
    } else {
      await this.api.rest.repos.createOrUpdateFileContents({
        ...this.scope,
        branch: 'evidence',
        path: file,
        message: `evidence: item #${number} [skip ci]`,
        content: png.toString('base64'),
      });
    }
    const wib = new Date(captured_at).toLocaleString('en-GB', {
      timeZone: 'Asia/Jakarta',
    });
    await this.comment(
      number,
      [
        marker('evidence', meta),
        `Evidence captured ${wib} WIB by @${user.login}.`,
        `![Reviewed evidence](https://github.com/${this.config.board_repo}/blob/evidence/${file}?raw=true)`,
        details.note,
      ].join('\n\n'),
      agent,
    );
    return meta;
  }

  async readEvidence(file: string): Promise<Buffer> {
    evidenceSchema.shape.file.parse(file);
    const entry = z
      .object({
        sha: z.string(),
        content: z.string(),
        encoding: z.enum(['base64', 'none']),
      })
      .parse(
        (
          await this.api.rest.repos.getContent({
            ...this.scope,
            path: file,
            ref: 'evidence',
          })
        ).data,
      );
    const content =
      entry.encoding === 'base64'
        ? entry.content
        : z
            .object({ encoding: z.literal('base64'), content: z.string() })
            .parse(
              (
                await this.api.rest.git.getBlob({
                  ...this.scope,
                  file_sha: entry.sha,
                })
              ).data,
            ).content;
    z.string()
      .max(15 * 1024 * 1024)
      .parse(content);
    const png = Buffer.from(content, 'base64');
    validatePng(png);
    return png;
  }

  async reconcile(issue: Issue, state: WorkflowState): Promise<void> {
    const labels = issue.labels.filter(
      (label) =>
        !['status:', 'dispute:', 'resolution:', 'severity:'].some((prefix) =>
          label.startsWith(prefix),
        ) && label !== 'triage:confirmed',
    );
    labels.push(`status:${state.status}`, `severity:${state.severity}`);
    if (state.pending_dispute) labels.push(`dispute:${state.pending_dispute}`);
    if (state.resolution) labels.push(`resolution:${state.resolution}`);
    if (state.confirmed_by) labels.push('triage:confirmed');
    await this.api.rest.issues.setLabels({
      ...this.scope,
      issue_number: issue.number,
      labels,
    });
    const summary =
      `## Validation trail\nStatus: **${state.status}**. Requested by: ${state.validation_requested_by ?? 'not requested'}.\n` +
      `Validated by: ${state.validated_by_name ?? 'not validated'}. Rejections: ${state.reject_count}.\n` +
      'The authoritative details are in the audited comments below.\n';
    const section = /## Validation trail\n[\s\S]*?(?=\n## |$)/;
    const body = section.test(issue.body)
      ? issue.body.replace(section, () => summary)
      : `${issue.body}\n\n${summary}`;
    await this.api.rest.issues.update({
      ...this.scope,
      issue_number: issue.number,
      body,
      state: state.status === 'done' ? 'closed' : 'open',
      assignees: state.assignees,
    });
  }

  async guard(number: number): Promise<void> {
    const issue = await this.issue(number);
    if (issue.pull_request || !issue.labels.includes('pronoia')) return;
    const comments = await this.comments(number);
    const plan = guardPlan(issue, comments, this.config);
    if (plan.relabel) {
      await this.api.rest.issues.setLabels({
        ...this.scope,
        issue_number: number,
        labels: [
          ...issue.labels.filter((label) => !label.startsWith('status:')),
          `status:${plan.status}`,
        ],
      });
    }
    if (plan.reopen || plan.close) {
      await this.api.rest.issues.update({
        ...this.scope,
        issue_number: number,
        state: plan.close ? 'closed' : 'open',
      });
    }
    if (plan.reopen || plan.close || plan.relabel) {
      await this.comment(
        number,
        plan.reopen
          ? 'Pronoia guard: close via /approve after independent human validation.'
          : `Pronoia guard: use comment commands; restored the audited status ${plan.status}.`,
      );
    }
  }

  async approvalContext(
    issue: Issue,
    state: WorkflowState,
  ): Promise<WorkflowState> {
    const comments = await this.comments(issue.number);
    const text = `${issue.body}\n${comments.map((comment) => comment.body).join('\n')}`;
    const references = new Map<
      string,
      { owner: string; repo: string; number: number; kind: 'pr' | 'issue' }
    >();
    const addReference = (
      repository: string,
      number: number,
      kind: 'pr' | 'issue',
    ) => {
      const [owner, repo] = repoSchema.parse(repository).split('/');
      if (!owner || !repo) throw new CommandError('Invalid GitHub reference.');
      const key = `${repository.toLowerCase()}#${number}`;
      if (!references.has(key) || kind === 'pr')
        references.set(key, { owner, repo, number, kind });
    };
    for (const match of text.matchAll(
      /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9]\d*)/g,
    )) {
      if (match[1] && match[3])
        addReference(
          match[1],
          Number(match[3]),
          match[2] === 'pull' ? 'pr' : 'issue',
        );
    }
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9_/#])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)/g,
    )) {
      if (match[2])
        addReference(
          match[1] || this.config.board_repo,
          Number(match[2]),
          'issue',
        );
    }
    for (const match of text.matchAll(/\bGH-([1-9]\d*)\b/gi)) {
      if (match[1])
        addReference(this.config.board_repo, Number(match[1]), 'issue');
    }
    const timeline = await this.api.paginate(
      this.api.rest.issues.listEventsForTimeline,
      { ...this.scope, issue_number: issue.number, per_page: 100 },
    );
    for (const event of timeline) {
      const parsed = z
        .object({
          event: z.string(),
          source: z
            .object({
              issue: z.object({
                html_url: z.url(),
                pull_request: z.unknown().optional(),
              }),
            })
            .optional(),
        })
        .passthrough()
        .parse(event);
      if (
        parsed.event === 'cross-referenced' &&
        parsed.source?.issue.pull_request
      ) {
        const match =
          /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/.exec(
            parsed.source.issue.html_url,
          );
        if (match?.[1] && match[2])
          addReference(match[1], Number(match[2]), 'pr');
      }
    }
    if (references.size > 30)
      throw new CommandError('Too many GitHub references to verify safely.');
    const authors = new Set<string>();
    let merged = false;
    for (const reference of references.values()) {
      try {
        if (reference.kind === 'issue') {
          const linked = (
            await this.api.rest.issues.get({
              owner: reference.owner,
              repo: reference.repo,
              issue_number: reference.number,
            })
          ).data;
          if (!linked.pull_request) continue;
        }
        const pr = (
          await this.api.rest.pulls.get({
            owner: reference.owner,
            repo: reference.repo,
            pull_number: reference.number,
          })
        ).data;
        if (!pr.user)
          throw new CommandError('Linked PR author cannot be verified.');
        authors.add(pr.user.login);
        merged ||= pr.merged_at !== null;
      } catch (error) {
        if (!httpStatus(error, 403) && !httpStatus(error, 404)) throw error;
        throw new CommandError(
          `Cannot verify GitHub reference ${reference.owner}/${reference.repo}#${reference.number}.`,
        );
      }
    }
    const paths = new Set(
      (await this.evidenceFiles(issue.number)).map((entry) => entry.path),
    );
    const verified = new Set<string>();
    for (const comment of comments) {
      if (
        !comment.user ||
        (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(
          comment.author_association,
        ) &&
          !isAuditWriter(comment.user.login))
      )
        continue;
      const match = /<!-- pronoia:evidence (.*?) -->/s.exec(comment.body);
      if (!match?.[1]) continue;
      const evidence = evidenceSchema.parse(JSON.parse(match[1]));
      if (!paths.has(evidence.file) || verified.has(evidence.file)) continue;
      const png = await this.readEvidence(evidence.file);
      if (
        createHash('sha256').update(png).digest('hex') !== evidence.sha256 ||
        !evidence.file.endsWith(`-${evidence.sha256.slice(0, 8)}.png`)
      ) {
        throw new EvidenceError(
          'Published evidence hash does not match its audited record.',
        );
      }
      verified.add(evidence.file);
    }
    return {
      ...state,
      assignees: issue.assignees.map((user) => user.login),
      pr_authors: [...authors],
      has_merged_pr: merged,
      evidence_count: verified.size,
      alert_fixed: false,
    };
  }

  async applyCommands(
    number: number,
  ): Promise<{ accepted: number; rejected: number }> {
    await this.guard(number);
    let issue = await this.issue(number);
    if (issue.pull_request || !issue.labels.includes('pronoia'))
      return { accepted: 0, rejected: 0 };
    const comments = await this.comments(number);
    const processed = new Set<number>();
    const audits: { comment: IssueComment; audit: Audit }[] = [];
    const completed = new Set<number>();
    for (const comment of comments) {
      if (!comment.user) continue;
      const audit = readAudit(comment.body, comment.user.login);
      if (audit) {
        processed.add(audit.comment_id);
        audits.push({ comment, audit });
      }
      if (!isAuditWriter(comment.user.login)) continue;
      const match = /<!-- pronoia:command-result (.*?) -->/s.exec(comment.body);
      if (match?.[1]) {
        const result = z
          .object({
            comment_id: z.number().int().positive(),
            accepted: z.boolean(),
          })
          .parse(JSON.parse(match[1]));
        processed.add(result.comment_id);
        if (result.accepted) completed.add(result.comment_id);
      }
    }
    const incomplete = audits.filter(
      (entry) => !completed.has(entry.audit.comment_id),
    );
    if (incomplete.length) {
      const latest = audits.at(-1);
      if (!latest) throw new Error('Incomplete journal has no audit.');
      await this.reconcile(issue, latest.audit.state);
      for (const entry of incomplete) {
        await this.api.rest.reactions.createForIssueComment({
          ...this.scope,
          comment_id: entry.audit.comment_id,
          content: '+1',
        });
        await this.api.rest.issues.updateComment({
          ...this.scope,
          comment_id: entry.comment.id,
          body: `${entry.comment.body}\n\n${marker('command-result', { comment_id: entry.audit.comment_id, accepted: true })}`,
        });
      }
      issue = await this.issue(number);
    }
    let state = expectedState(issue, comments, this.config);
    let accepted = 0;
    let rejected = 0;
    for (const comment of comments) {
      if (!comment.body.startsWith('/') || processed.has(comment.id)) continue;
      const actor: Actor = {
        login: comment.user?.login ?? 'deleted',
        userType: comment.user?.type ?? 'User',
        association: comment.author_association,
      };
      let result: WorkflowState;
      let command: Command;
      let audit: Audit;
      let auditBody: string;
      const at = new Date().toISOString();
      try {
        if (!comment.user)
          throw new CommandError('Deleted users cannot authorize commands.');
        actor.agent = parseAgentMarker(comment.body);
        const parsed = parseCommand(comment.body);
        if (!parsed) continue;
        command = parsed;
        authorize(command, actor, this.config);
        if (
          !allowedCommands(state.status, actor, this.config).includes(
            command.name,
          )
        ) {
          throw new CommandError(
            `/${command.name} is not allowed from ${state.status}.`,
          );
        }
        if (['ai', 'copilot'].includes(command.name)) {
          throw new CommandError(
            `/${command.name} requires the M2 integration.`,
          );
        }
        if (command.name === 'approve')
          state = await this.approvalContext(issue, state);
        result = nextState(state, command, actor, this.config, at);
        audit = {
          from: state.status,
          to: result.status,
          command,
          actor: actor.login,
          actor_type: actorType(actor, this.config),
          on_behalf_of: command.validatedBy,
          reason: command.reason,
          evidence_count: state.evidence_count,
          at,
          comment_id: comment.id,
          state: result,
        };
        auditBody = `Pronoia audit: /${command.name}: ${state.status} -> ${result.status}, by @${actor.login}.\n\n${marker('transition', audit)}`;
        if (auditBody.length + 200 > 60000) {
          throw new CommandError(
            'Serialized audit is too large; shorten the reason or validation name.',
          );
        }
      } catch (error) {
        if (!(
          error instanceof CommandError ||
          error instanceof EvidenceError ||
          error instanceof z.ZodError ||
          error instanceof SyntaxError
        )) {
          throw error;
        }
        const reason =
          error instanceof CommandError || error instanceof EvidenceError
            ? error.message
            : 'Invalid command arguments or agent marker.';
        await this.api.rest.reactions.createForIssueComment({
          ...this.scope,
          comment_id: comment.id,
          content: '-1',
        });
        await this.comment(
          number,
          `Pronoia rejected command: ${reason}\n\nAllowed in ${state.status}: ${allowedCommands(
            state.status,
            actor,
            this.config,
          )
            .map((name) => `/${name}`)
            .join(', ')}.\n\n` +
            marker('command-result', {
              comment_id: comment.id,
              accepted: false,
            }),
        );
        rejected += 1;
        continue;
      }
      // Journal first so a retried workflow can repair interrupted API writes.
      const journal = await this.comment(number, auditBody);
      await this.reconcile(issue, result);
      await this.api.rest.reactions.createForIssueComment({
        ...this.scope,
        comment_id: comment.id,
        content: '+1',
      });
      await this.api.rest.issues.updateComment({
        ...this.scope,
        comment_id: journal.id,
        body: `${auditBody}\n\n${marker('command-result', { comment_id: comment.id, accepted: true })}`,
      });
      state = result;
      issue = await this.issue(number);
      accepted += 1;
    }
    return { accepted, rejected };
  }
}
