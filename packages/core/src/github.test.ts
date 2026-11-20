import { Octokit } from 'octokit';
import { expect, it, vi } from 'vitest';
import { Board } from './github.js';
import { configSchema } from './config.js';
import { assessmentRows } from './assessment.js';

function fixture() {
  const issue = {
    number: 1,
    title: 'Synthetic MFA check',
    body: '',
    labels: ['pronoia', 'status:todo'],
    assignees: [] as { login: string }[],
    state: 'open',
    html_url: 'https://github.com/Contoso/demo/issues/1',
    created_at: '2026-11-20T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
  };
  const comments: {
    id: number;
    body: string;
    user: { login: string; type: string };
    author_association: string;
    created_at: string;
    html_url: string;
  }[] = [];
  const labels = new Set<string>();
  const files = new Map<string, Buffer>();
  const prs = new Map<
    number,
    { user: { login: string }; merged_at: string | null }
  >();
  const milestones: { number: number; title: string }[] = [];
  let evidenceBranch = false;
  const issues = [issue];
  const posted: string[] = [];
  const positiveReactions = new Set<number>();
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    let data: unknown;
    if (method === 'GET' && path.endsWith('/issues/1/comments'))
      data = comments;
    else if (method === 'GET' && path.endsWith('/issues/1/timeline')) data = [];
    else if (method === 'GET' && path.endsWith('/issues/1')) data = issue;
    else if (method === 'GET' && /\/issues\/\d+$/.test(path)) {
      const number = Number(path.split('/').at(-1));
      const pr = prs.get(number);
      if (!pr) throw new Error('Unknown fixture reference');
      data = {
        ...issue,
        number,
        html_url: `https://github.com/Contoso/demo/pull/${number}`,
        pull_request: {
          url: `https://api.github.com/repos/Contoso/demo/pulls/${number}`,
        },
      };
    } else if (method === 'GET' && path.endsWith('/issues')) data = issues;
    else if (method === 'GET' && path.endsWith('/labels'))
      data = [...labels].map((name) => ({ name }));
    else if (method === 'GET' && path.endsWith('/milestones'))
      data = milestones;
    else if (method === 'GET' && path === '/repos/Contoso/demo')
      data = { private: false, default_branch: 'main' };
    else if (method === 'GET' && path.includes('/pulls/'))
      data = prs.get(Number(path.split('/').at(-1)));
    else if (
      method === 'GET' &&
      path.endsWith('/git/trees/evidence') &&
      evidenceBranch
    )
      data = {
        truncated: false,
        tree: [...files.keys()].map((path) => ({
          type: 'blob',
          path,
          sha: 'c'.repeat(40),
        })),
      };
    else if (
      method === 'GET' &&
      path.endsWith('/git/ref/heads/evidence') &&
      evidenceBranch
    )
      data = { ref: 'refs/heads/evidence', object: { sha: 'b'.repeat(40) } };
    else if (
      method === 'GET' &&
      path.includes('/contents/') &&
      files.has(decodeURIComponent(path.split('/contents/')[1] ?? ''))
    ) {
      const file = files.get(
        decodeURIComponent(path.split('/contents/')[1] ?? ''),
      );
      if (!file) throw new Error('Missing fixture file');
      data = {
        type: 'file',
        sha: 'c'.repeat(40),
        encoding: 'base64',
        content: file.toString('base64'),
      };
    } else if (
      method === 'GET' &&
      (path.includes('/git/') || path.includes('/contents/'))
    ) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    } else if (method === 'GET' && path === '/user')
      data = { login: 'human', type: 'User' };
    else if (method === 'PUT' && path.endsWith('/issues/1/labels')) {
      const value = body as { labels: string[] };
      issue.labels = value.labels;
      writes += 1;
      data = value.labels.map((name) => ({ name }));
    } else if (method === 'PATCH' && path.endsWith('/issues/1')) {
      Object.assign(issue, body);
      const update = body as { assignees?: string[] };
      if (update.assignees)
        issue.assignees = update.assignees.map((login) => ({ login }));
      writes += 1;
      data = issue;
    } else if (method === 'POST' && path.endsWith('/labels')) {
      const value = body as { name: string };
      labels.add(value.name);
      data = value;
    } else if (method === 'POST' && path.endsWith('/issues/1/comments')) {
      const value = body as { body: string };
      posted.push(value.body);
      const comment = {
        id: comments.length + 100,
        body: value.body,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        author_association: 'MEMBER',
        created_at: '2026-11-20T12:00:00Z',
        html_url: 'https://github.com/Contoso/demo/issues/1#comment',
      };
      comments.push(comment);
      data = comment;
    } else if (method === 'POST' && path.endsWith('/issues')) {
      const value = body as {
        title: string;
        body: string;
        labels: string[];
        milestone?: number;
      };
      const milestone =
        value.milestone === undefined
          ? null
          : milestones.find((entry) => entry.number === value.milestone);
      if (value.milestone !== undefined && !milestone)
        throw new Error('Unknown fixture milestone');
      const created = {
        ...issue,
        ...value,
        milestone,
        number: issues.length + 1,
      };
      issues.push(created);
      writes += 1;
      data = created;
    } else if (method === 'POST' && path.endsWith('/milestones')) {
      const value = body as { title: string };
      const milestone = { number: milestones.length + 1, title: value.title };
      milestones.push(milestone);
      data = milestone;
    } else if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(path)) {
      const comment = comments.find(
        (entry) => entry.id === Number(path.split('/').at(-1)),
      );
      if (!comment) throw new Error('Unknown fixture comment');
      comment.body = (body as { body: string }).body;
      data = comment;
    } else if (method === 'POST' && path.endsWith('/reactions')) {
      const id = Number(/\/comments\/(\d+)\/reactions$/.exec(path)?.[1]);
      if ((body as { content: string }).content === '+1')
        positiveReactions.add(id);
      data = { id: 1 };
    } else if (method === 'POST' && path.endsWith('/git/trees'))
      data = { sha: 'a'.repeat(40) };
    else if (method === 'POST' && path.endsWith('/git/commits'))
      data = { sha: 'b'.repeat(40) };
    else if (method === 'POST' && path.endsWith('/git/refs')) {
      evidenceBranch = true;
      data = { ref: 'refs/heads/evidence', object: { sha: 'b'.repeat(40) } };
    } else if (method === 'PUT' && path.includes('/contents/')) {
      const name = decodeURIComponent(path.split('/contents/')[1] ?? '');
      const value = body as { content: string; sha?: string };
      if (!name) throw new Error('Missing fixture path');
      if (files.has(name) && !value.sha)
        return new Response(
          JSON.stringify({ message: 'sha is required for an existing path' }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        );
      files.set(name, Buffer.from(value.content, 'base64'));
      writes += 1;
      data = {
        content: { path: name, sha: 'c'.repeat(40) },
        commit: { sha: 'd'.repeat(40) },
      };
    } else throw new Error(`Unhandled fixture request: ${method} ${path}`);
    return new Response(JSON.stringify(data), {
      status: method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const config = configSchema.parse({ board_repo: 'Contoso/demo' });
  const client = new Octokit({
    request: { fetch: fetcher },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  const board = new Board(client, config);
  function command(body: string, login = 'requester', agent = '') {
    const id = comments.length + 1;
    comments.push({
      id,
      body: body + agent,
      user: { login, type: 'User' },
      author_association: 'COLLABORATOR',
      created_at: '2026-11-20T12:00:00Z',
      html_url: 'https://github.com/Contoso/demo/issues/1#command',
    });
    return id;
  }
  return {
    board,
    issue,
    comments,
    labels,
    issues,
    posted,
    command,
    files,
    prs,
    milestones,
    positiveReactions,
    writes: () => writes,
  };
}

it('processes queued commands once and repairs interrupted status writes from trusted audit', async () => {
  const f = fixture();
  f.command('/start');
  f.command('/validate verified in synthetic test');
  await f.board.applyCommands(1);
  expect(f.issue.labels).toContain('status:validate');
  expect(f.issue.assignees).toEqual([{ login: 'requester' }]);
  const count = f.posted.length;
  await f.board.applyCommands(1);
  expect(f.posted).toHaveLength(count);
  f.issue.labels = ['pronoia', 'status:done'];
  f.issue.state = 'closed';
  await f.board.guard(1);
  expect(f.issue.labels).toContain('status:validate');
  expect(f.issue.state).toBe('open');
});

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const reviewed = {
  note: 'Synthetic test image; reviewed.',
  source: 'test',
  reviewed: true,
  synthetic: true,
};

it('publishes reviewed synthetic PNGs on an orphan evidence branch and audits the hash', async () => {
  const f = fixture();
  await expect(
    f.board.addEvidence(1, pixel, { ...reviewed, reviewed: false }),
  ).rejects.toThrow(/review/i);
  await expect(
    f.board.addEvidence(1, pixel, { ...reviewed, synthetic: false }),
  ).rejects.toThrow(/synthetic/i);
  const evidence = await f.board.addEvidence(1, pixel, reviewed);
  expect(f.files.get(evidence.file)).toEqual(pixel);
  expect(f.posted.join('\n')).toContain(evidence.sha256);
  expect(await f.board.evidenceFiles(1)).toHaveLength(1);
  expect(await f.board.evidenceFiles(2)).toHaveLength(0);
});

it('reuses an identical screenshot captured in the same second without a failed second upload', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  try {
    const f = fixture();
    const first = await f.board.addEvidence(1, pixel, reviewed);
    const second = await f.board.addEvidence(1, pixel, reviewed);
    expect(second.file).toBe(first.file);
    expect(f.files.size).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('checks linked PR authors and closes only after a different human approves with evidence', async () => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  await f.board.addEvidence(1, pixel, reviewed);
  f.issue.body += '\n\n## Linked PRs\nhttps://github.com/Contoso/demo/pull/9';
  f.prs.set(9, { user: { login: 'fixer' }, merged_at: '2026-11-20T12:00:00Z' });
  f.command('/approve', 'fixer');
  f.command(
    '/approve\nValidated-by: Fictional Contoso validator',
    'independent',
  );
  const result = await f.board.applyCommands(1);
  expect(result).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.state).toBe('closed');
  expect(f.issue.labels).toContain('status:done');
  expect(f.posted.join('\n')).toContain('Four-eyes');
});

it('refuses agent human-only comments before posting and stamps allowed commands', async () => {
  const f = fixture();
  await expect(f.board.comment(1, '/approve', 'scout')).rejects.toThrow(
    /Agents/i,
  );
  expect(f.posted).toHaveLength(0);
  await f.board.comment(1, '/validate verified', 'scout');
  expect(f.posted[0]).toContain('pronoia:agent');
});

it('refuses To Do approval, missing reasons and agent-stamped human-only commands with an explanation', async () => {
  const f = fixture();
  f.command('/approve');
  f.command('/reject');
  f.command(
    '/approve',
    'reviewer',
    '\n<!-- pronoia:agent {"agent":"scout"} -->',
  );
  await f.board.applyCommands(1);
  expect(f.issue.labels).toContain('status:todo');
  expect(
    f.posted.filter((body) => body.includes('pronoia:command-result')),
  ).toHaveLength(3);
  expect(f.posted.join('\n')).toMatch(/allowed|human-only|reason/i);
  expect(f.issue.state).toBe('open');
  const count = f.posted.length;
  await f.board.applyCommands(1);
  expect(f.posted).toHaveLength(count);
});

it('imports idempotently and performs no writes on dry-run', async () => {
  const f = fixture();
  const rows = assessmentRows(
    'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nS1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,',
  );
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', {
      dryRun: true,
      synthetic: true,
    }),
  ).toMatchObject({ created: 0, planned: 1 });
  expect(f.writes()).toBe(0);
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', { synthetic: true }),
  ).toMatchObject({ created: 1 });
  expect(
    await f.board.importAssessment(rows, 'Synthetic demo', { synthetic: true }),
  ).toMatchObject({ created: 0 });
  expect(f.milestones).toEqual([{ number: 1, title: 'Synthetic demo' }]);
});

it('rejects invalid evidence without poisoning the following command queue', async () => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  const evidence = await f.board.addEvidence(1, pixel, reviewed);
  f.files.set(evidence.file, Buffer.from('tampered, not a PNG'));
  f.command('/approve', 'independent');
  f.command('/reject evidence needs recapture', 'independent');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.state).toBe('open');
  expect(f.issue.labels).toContain('status:in-progress');
});

it.each([
  '#9',
  'GH-9',
  'Contoso/demo#9',
  'https://github.com/Contoso/demo/issues/9',
])('enforces four-eyes for the GitHub reference form %s', async (reference) => {
  const f = fixture();
  f.command('/start', 'worker');
  f.command('/validate tested', 'requester');
  await f.board.applyCommands(1);
  await f.board.addEvidence(1, pixel, reviewed);
  f.issue.body += `\n\n## Linked PRs\nRefs ${reference}`;
  f.prs.set(9, {
    user: { login: 'fixer' },
    merged_at: '2026-11-20T12:00:00Z',
  });
  f.command('/approve', 'fixer');
  expect(await f.board.applyCommands(1)).toEqual({
    accepted: 0,
    rejected: 1,
  });
  expect(f.issue.state).toBe('open');
});

it.each(['/assign @new-worker', '/severity high'])(
  'recovers the journaled metadata after a failed write: %s',
  async (body) => {
    const f = fixture();
    f.issue.labels.push('severity:medium');
    f.command(body);
    vi.spyOn(f.board.api.rest.issues, 'setLabels').mockRejectedValueOnce(
      new Error('transient write failure'),
    );
    await expect(f.board.applyCommands(1)).rejects.toThrow(
      'transient write failure',
    );
    await f.board.applyCommands(1);
    if (body.startsWith('/assign'))
      expect(f.issue.assignees).toEqual([{ login: 'new-worker' }]);
    else expect(f.issue.labels).toContain('severity:high');
  },
);

it('recovers a missing success reaction after an interrupted accepted command', async () => {
  const f = fixture();
  const id = f.command('/start');
  vi.spyOn(
    f.board.api.rest.reactions,
    'createForIssueComment',
  ).mockRejectedValueOnce(new Error('transient reaction failure'));
  await expect(f.board.applyCommands(1)).rejects.toThrow(
    'transient reaction failure',
  );
  await f.board.applyCommands(1);
  expect(f.positiveReactions.has(id)).toBe(true);
});

it('rejects unsendable serialized audits and continues with later commands', async () => {
  const f = fixture();
  f.command(`/block ${'<'.repeat(10000)}`);
  f.command('/start');
  expect(await f.board.applyCommands(1)).toEqual({ accepted: 1, rejected: 1 });
  expect(f.issue.labels).toContain('status:in-progress');
});

it('prevents human-only agent commands even when the marker is already in the body', async () => {
  const f = fixture();
  await expect(
    f.board.comment(1, '/approve\n<!-- pronoia:agent {"agent":"scout"} -->'),
  ).rejects.toThrow(/agent/i);
  expect(f.posted).toHaveLength(0);
});

it('does not publish unreviewed real data to a public repository', async () => {
  const f = fixture();
  const rows = assessmentRows(
    'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nS1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,',
  );
  await expect(
    f.board.importAssessment(rows, 'Engagement', {}),
  ).rejects.toThrow(/synthetic|public/i);
  expect(f.writes()).toBe(0);
});

it('updates only the validation section without erasing later human-authored sections', async () => {
  const f = fixture();
  f.issue.body =
    '## Test\nSynthetic test.\n\n## Validation trail\nOld summary.\n\n## Extra details\nPreserve this note.';
  f.command('/start');
  await f.board.applyCommands(1);
  expect(f.issue.body).toContain('## Extra details\nPreserve this note.');
});
