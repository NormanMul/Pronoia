import { readFileSync } from 'node:fs';
import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { Board, issueSchema, type IssueComment } from '../github.js';
import { configSchema } from '../config.js';
import { marker, metaSchema, readMeta } from '../assessment.js';
import { stateSchema, auditSchema } from '../workflow/schemas.js';
import { SecurityAlerts } from './alerts.js';
import { Enricher, JsonCache } from './enrichment.js';
import {
  discoverSecurity,
  importSecurityFindings,
  syncSecurityIssue,
  securityCommand,
  readObservation,
  verifyOnMerge,
} from './sync.js';

const repo = 'NormanMul/Pronoia';
function fixture() {
  const raw = JSON.parse(
    readFileSync(
      new URL('../../../../samples/security/dependabot.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>[];
  const config = configSchema.parse({ board_repo: repo });
  const api = new Octokit({
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(api, config);
  const alerts = new SecurityAlerts(api);
  const issue = issueSchema.parse({
    number: 1,
    title: 'Synthetic dependency',
    body: '',
    labels: ['pronoia', 'status:todo', 'severity:high'],
    state: 'open',
    assignees: [],
    html_url: `https://github.com/${repo}/issues/1`,
    created_at: '2026-11-01T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  });
  const comments: IssueComment[] = [];
  const issues: (typeof issue)[] = [];
  vi.spyOn(board, 'isPublic').mockResolvedValue(true);
  vi.spyOn(board, 'issues').mockImplementation(async () => issues);
  vi.spyOn(board, 'issue').mockImplementation(async () => issue);
  vi.spyOn(board, 'comments').mockImplementation(async () => comments);
  vi.spyOn(board, 'setupLabels').mockResolvedValue();
  vi.spyOn(board, 'applyCommands').mockResolvedValue({
    accepted: 0,
    rejected: 0,
  });
  vi.spyOn(board, 'comment').mockImplementation(async (_number, body) => {
    const comment: IssueComment = {
      id: comments.length + 100,
      body,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      author_association: 'NONE',
      created_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/${repo}/issues/1#comment`,
    };
    comments.push(comment);
    return comment;
  });
  vi.spyOn(api.rest.repos, 'get').mockResolvedValue({
    data: { private: false },
  } as Awaited<ReturnType<typeof api.rest.repos.get>>);
  vi.spyOn(api.rest.issues, 'update').mockImplementation(async (params) => {
    if (params?.body) issue.body = params.body;
    return { data: issue } as Awaited<
      ReturnType<typeof api.rest.issues.update>
    >;
  });
  vi.spyOn(api.rest.issues, 'setLabels').mockImplementation(async (params) => {
    issue.labels =
      params?.labels?.map((label) =>
        typeof label === 'string' ? label : (label.name ?? ''),
      ) ?? [];
    return {
      data: [],
      status: 200,
      url: `https://api.github.com/repos/${repo}/issues/1/labels`,
      headers: {},
    };
  });
  vi.spyOn(api.rest.issues, 'create').mockImplementation(async (params) => {
    const created = {
      ...issue,
      number: issues.length + 1,
      body: params?.body ?? '',
    };
    if (!issues.length) Object.assign(issue, created);
    issues.push(issues.length ? created : issue);
    return { data: created } as Awaited<
      ReturnType<typeof api.rest.issues.create>
    >;
  });
  vi.spyOn(alerts, 'list').mockImplementation(async () => ({
    findings: (await import('./findings.js')).ingestDependabot(raw, repo),
    warnings: [],
  }));
  vi.spyOn(alerts, 'get').mockImplementation(async () => ({
    finding:
      (await import('./findings.js')).ingestDependabot([raw[0]], repo)[0] ??
      null,
    warning: null,
  }));
  const enricher = new Enricher(api, new JsonCache());
  vi.spyOn(enricher, 'enrich').mockImplementation(
    async (findings) =>
      new Map(
        findings.map((finding) => [
          finding.key,
          {
            cvss: 7.2,
            epss: null,
            epss_percentile: null,
            epss_date: null,
            kev: false,
            kev_due_date: null,
            warnings: ['EPSS unavailable.'],
          },
        ]),
      ),
  );
  return { raw, api, board, alerts, enricher, issue, comments };
}

it('discovers all configured targets, creates/deduplicates and preserves synthetic publication policy', async () => {
  const f = fixture();
  const first = await discoverSecurity(f.board, f.alerts, f.enricher);
  expect(first.created).toBe(2);
  expect(f.api.rest.issues.create).toHaveBeenCalledTimes(2);
  expect(readMeta(f.issue.body)?.due_date).toBe('2026-11-15');
  const again = await discoverSecurity(f.board, f.alerts, f.enricher);
  expect(again.created).toBe(0);
  const privateRepo = vi.mocked(f.api.rest.repos.get);
  privateRepo.mockResolvedValue({ data: { private: true } } as Awaited<
    ReturnType<typeof f.api.rest.repos.get>
  >);
  await expect(
    discoverSecurity(f.board, f.alerts, f.enricher, { synthetic: true }),
  ).rejects.toThrow(/private|public/i);
});

it('updates finding metadata without erasing human sections or resetting anchored SLAs', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  f.issue.body += '\n\n## Human notes\nPreserve this.';
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    at: '2026-11-30T12:00:00Z',
  });
  expect(readMeta(f.issue.body)?.due_date).toBe('2026-11-15');
  expect(f.issue.labels).toContain('sla:breached');
  expect(f.issue.body).toContain('## Human notes\nPreserve this.');
  expect(f.api.rest.issues.update).not.toHaveBeenCalledWith(
    expect.objectContaining({ state: expect.anything() }),
  );
});

it('queues verified fixed/dismissed /validate commands and records command IDs idempotently', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  f.raw[0] = { ...f.raw[0], state: 'fixed' };
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  const commands = f.comments.filter((comment) =>
    comment.body.startsWith('/validate'),
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]?.body).toContain('verified');
  expect(
    readObservation(f.comments, readMeta(f.issue.body)?.dedupe_key ?? '')
      ?.command_ids,
  ).toContain(commands[0]?.id);
});

it('does not immediately reopen a still-open approved risk acceptance; actual reappearance does', () => {
  const state = stateSchema.parse({
    status: 'done',
    resolution: 'risk-accepted',
    risk_until: '2026-11-21',
  });
  const current = {
    state: 'open' as const,
    updated_at: '2026-11-20T12:00:00Z',
  };
  expect(
    securityCommand(state, current, 'open', '2026-11-21T16:59:59Z'),
  ).toBeNull();
  expect(
    securityCommand(state, current, 'dismissed', '2026-11-21T16:59:59Z'),
  ).toMatch(/^\/reopen/);
  expect(
    securityCommand(state, current, null, '2026-11-21T16:59:59Z'),
  ).toBeNull();
  expect(
    securityCommand(state, current, 'open', '2026-11-21T17:00:00Z'),
  ).toMatch(/^\/reopen.*expired/);
  expect(
    securityCommand(
      stateSchema.parse({
        status: 'done',
        resolution: 'fixed',
        alert_fixed: true,
      }),
      current,
      'open',
      '2026-11-20T12:00:00Z',
    ),
  ).toMatch(/^\/reopen/);
});

it('ignores human-made observation markers and preserves unavailable-alert uncertainty', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  const key = readMeta(f.issue.body)?.dedupe_key ?? '';
  f.comments.push({
    id: 1,
    body: marker('security-observation', {
      key,
      state: 'fixed',
      at: '2026-11-20T12:00:00Z',
      command_ids: [],
    }),
    user: { login: 'human', type: 'User' },
    author_association: 'OWNER',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${repo}/issues/1#comment`,
  });
  expect(readObservation(f.comments, key)).toBeNull();
  vi.mocked(f.alerts.get).mockResolvedValue({
    finding: null,
    warning: 'HTTP 403 scanner unavailable.',
  });
  const result = await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  expect(result.warnings).toContain('HTTP 403 scanner unavailable.');
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/')),
  ).toHaveLength(0);
});

it('never dismisses source alerts without an audited human approval and auto_dismiss enabled', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  const request = vi
    .spyOn(f.api, 'request')
    .mockResolvedValue({ data: {} } as Awaited<
      ReturnType<typeof f.api.request>
    >);
  f.board.config.auto_dismiss = true;
  f.issue.labels = ['pronoia', 'status:done'];
  f.comments.push({
    id: 1,
    body: marker(
      'transition',
      auditSchema.parse({
        from: 'validate',
        to: 'done',
        command: { name: 'approve' },
        actor: 'independent',
        actor_type: 'human',
        on_behalf_of: '',
        reason: '',
        evidence_count: 1,
        at: '2026-11-20T12:00:00Z',
        comment_id: 10,
        state: stateSchema.parse({
          status: 'done',
          resolution: 'risk-accepted',
          validated_by: 'independent',
          risk_until: '2026-12-20',
        }),
      }),
    ),
    user: { login: 'human', type: 'User' },
    author_association: 'OWNER',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${repo}/issues/1#comment`,
  });
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    dismissApi: f.api,
  });
  expect(request).not.toHaveBeenCalled();
});

it('verifies real same-repo merge references before posting /validate, never /approve', async () => {
  const f = fixture();
  f.issue.body = marker(
    'meta',
    metaSchema.parse({
      dedupe_key: 'checklist/demo/one',
      source: 'checklist',
      assessment: 'demo',
      test_id: 'one',
      synthetic: true,
    }),
  );
  vi.spyOn(f.api.rest.pulls, 'get').mockResolvedValue({
    data: {
      title: 'Refs #1',
      body: '',
      merged_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/${repo}/pull/9`,
      base: { repo: { full_name: repo } },
      head: { repo: { full_name: repo } },
    },
  } as Awaited<ReturnType<typeof f.api.rest.pulls.get>>);
  await verifyOnMerge(f.board, f.alerts, 9, 1);
  await verifyOnMerge(f.board, f.alerts, 9, 1);
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/validate')),
  ).toHaveLength(1);
  expect(f.comments.map((comment) => comment.body).join(' ')).not.toContain(
    '/approve',
  );
});

it('queues validated SARIF snapshots and updates them under the authoritative issue worker', async () => {
  const f = fixture();
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL('../../../../samples/security/sarif.json', import.meta.url),
      'utf8',
    ),
  );
  const { ingestSarif } = await import('./findings.js');
  const findings = ingestSarif(raw, repo, '2026-11-01T12:00:00Z');
  await importSecurityFindings(
    f.board,
    findings,
    f.enricher,
    'Synthetic SARIF',
    { synthetic: true },
  );
  const firstDue = readMeta(f.issue.body)?.due_date;
  await importSecurityFindings(
    f.board,
    findings.map((finding) => ({
      ...finding,
      description: 'Updated synthetic scanner description',
      updated_at: '2026-11-20T12:00:00Z',
    })),
    f.enricher,
    'Synthetic SARIF',
    { synthetic: true },
  );
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  expect(readMeta(f.issue.body)?.finding?.description).toBe(
    'Updated synthetic scanner description',
  );
  expect(readMeta(f.issue.body)?.due_date).toBe(firstDue);
  expect(f.comments.map((comment) => comment.body).join(' ')).toContain(
    'sarif-snapshot',
  );
  await expect(
    importSecurityFindings(f.board, findings, f.enricher, 'Real data', {
      synthetic: false,
    }),
  ).rejects.toThrow(/synthetic|public/i);
});

function approved(f: ReturnType<typeof fixture>, at = '2026-11-20T12:00:00Z') {
  f.comments.push({
    id: 50,
    body: marker(
      'transition',
      auditSchema.parse({
        from: 'validate',
        to: 'done',
        command: { name: 'approve' },
        actor: 'independent',
        actor_type: 'human',
        on_behalf_of: '',
        reason: '',
        evidence_count: 1,
        at,
        comment_id: 10,
        state: stateSchema.parse({
          status: 'done',
          resolution: 'risk-accepted',
          dispute_type: 'risk-accepted',
          disputed_by: 'requester',
          dispute_reason: 'Synthetic documented exception.',
          risk_until: '2026-12-20',
          validated_by: 'independent',
          validated_at: at,
        }),
      }),
    ),
    user: { login: 'github-actions[bot]', type: 'Bot' },
    author_association: 'NONE',
    created_at: at,
    html_url: `https://github.com/${repo}/issues/1#comment`,
  });
  f.issue.labels = ['pronoia', 'status:done', 'severity:high'];
}

it('dismisses only an audited human-approved dispute with the separate optional token and records proof IDs', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  approved(f);
  f.board.config.auto_dismiss = true;
  const open = await f.alerts.get({ repo, source: 'dependabot', number: 1 });
  if (!open.finding) throw new Error('Missing open fixture');
  vi.mocked(f.alerts.get)
    .mockResolvedValueOnce(open)
    .mockResolvedValue({
      finding: { ...open.finding, state: 'dismissed' },
      warning: null,
    });
  const request = vi
    .spyOn(f.api, 'request')
    .mockResolvedValue({ data: {} } as Awaited<
      ReturnType<typeof f.api.request>
    >);
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    dismissApi: f.api,
    at: '2026-11-20T12:00:00Z',
  });
  expect(request).toHaveBeenCalledWith(
    'PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}',
    expect.objectContaining({
      state: 'dismissed',
      dismissed_reason: 'tolerable_risk',
      alert_number: 1,
    }),
  );
  expect(f.comments.map((comment) => comment.body).join(' ')).toContain(
    '"approval_audit_id":50',
  );
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    dismissApi: f.api,
    at: '2026-11-21T12:00:00Z',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it('leaves a still-open approved exception intact with auto_dismiss false, and warns if optional credentials are absent', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  approved(f);
  const request = vi
    .spyOn(f.api, 'request')
    .mockResolvedValue({ data: {} } as Awaited<
      ReturnType<typeof f.api.request>
    >);
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    dismissApi: f.api,
    at: '2026-11-20T12:00:00Z',
  });
  expect(request).not.toHaveBeenCalled();
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/reopen')),
  ).toHaveLength(0);
  f.board.config.auto_dismiss = true;
  const result = await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    at: '2026-11-20T12:00:00Z',
  });
  expect(result.warnings.join(' ')).toMatch(/optional-dismiss.*unavailable/i);
});

it('does not invent a breach for an issue approved before its anchored SLA', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  approved(f, '2026-11-10T12:00:00Z');
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1, {
    at: '2026-11-30T12:00:00Z',
  });
  expect(f.issue.labels).not.toContain('sla:breached');
  expect(readMeta(f.issue.body)?.due_date).toBe('2026-11-15');
});

it('refreshes source severity without erasing a human severity override', async () => {
  const f = fixture();
  await discoverSecurity(f.board, f.alerts, f.enricher);
  const row = f.raw[0];
  if (!row) throw new Error('Missing fixture');
  f.raw[0] = {
    ...row,
    security_advisory: {
      ...(row.security_advisory as object),
      severity: 'critical',
    },
  };
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  expect(f.issue.labels).toContain('severity:critical');
  f.issue.labels = ['pronoia', 'status:todo', 'severity:low'];
  f.comments.push({
    id: 20,
    body: marker(
      'transition',
      auditSchema.parse({
        from: 'todo',
        to: 'todo',
        command: { name: 'severity', severity: 'low' },
        actor: 'human',
        actor_type: 'human',
        on_behalf_of: '',
        reason: '',
        evidence_count: 0,
        at: '2026-11-20T12:00:00Z',
        comment_id: 19,
        state: stateSchema.parse({ severity: 'low' }),
      }),
    ),
    user: { login: 'github-actions[bot]', type: 'Bot' },
    author_association: 'NONE',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${repo}/issues/1#comment`,
  });
  await syncSecurityIssue(f.board, f.alerts, f.enricher, 1);
  expect(f.issue.labels).toContain('severity:low');
  expect(f.issue.labels).not.toContain('severity:critical');
});

it('records real merge proof even if a source worker already requested validation', async () => {
  const f = fixture();
  f.issue.body = marker(
    'meta',
    metaSchema.parse({
      dedupe_key: 'checklist/demo/one',
      source: 'checklist',
      assessment: 'demo',
      test_id: 'one',
      synthetic: true,
    }),
  );
  f.comments.push({
    id: 3,
    body: marker(
      'transition',
      auditSchema.parse({
        from: 'todo',
        to: 'validate',
        command: { name: 'validate' },
        actor: 'worker',
        actor_type: 'human',
        on_behalf_of: '',
        reason: '',
        evidence_count: 0,
        at: '2026-11-20T12:00:00Z',
        comment_id: 2,
        state: stateSchema.parse({
          status: 'validate',
          validation_requested_by: 'worker',
        }),
      }),
    ),
    user: { login: 'github-actions[bot]', type: 'Bot' },
    author_association: 'NONE',
    created_at: '2026-11-20T12:00:00Z',
    html_url: `https://github.com/${repo}/issues/1#comment`,
  });
  vi.spyOn(f.api.rest.pulls, 'get').mockResolvedValue({
    data: {
      title: 'Refs #1',
      body: '',
      merged_at: '2026-11-20T12:00:00Z',
      base: { repo: { full_name: repo } },
      head: { repo: { full_name: repo } },
    },
  } as Awaited<ReturnType<typeof f.api.rest.pulls.get>>);
  await verifyOnMerge(f.board, f.alerts, 9, 1);
  await verifyOnMerge(f.board, f.alerts, 9, 1);
  expect(
    f.comments.filter((comment) =>
      comment.body.includes('pronoia:merge-proof'),
    ),
  ).toHaveLength(1);
  expect(f.comments.map((comment) => comment.body).join(' ')).toContain(
    `https://github.com/${repo}/pull/9`,
  );
  expect(
    f.comments.filter((comment) => comment.body.startsWith('/validate')),
  ).toHaveLength(0);
});
