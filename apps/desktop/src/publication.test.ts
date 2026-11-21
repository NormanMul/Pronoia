import { Octokit } from 'octokit';
import { Board, configSchema, type IssueComment } from '@pronoia/core';
import { expect, it, vi } from 'vitest';
import {
  pendingReviewText,
  postReviewedComment,
  PublicationLock,
} from './publication';

function fixture() {
  const comments: IssueComment[] = [];
  let loseReply = true;
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/issues/2/comments'))
      throw new Error('Unexpected test request');
    if ((init?.method ?? 'GET') === 'GET') return Response.json(comments);
    const body: { body: string } = JSON.parse(String(init?.body));
    writes += 1;
    comments.push({
      id: writes,
      body: body.body,
      user: { login: 'tester', type: 'User' },
      author_association: 'COLLABORATOR',
      created_at: '2026-11-20T12:00:00Z',
      html_url: `https://github.com/Contoso/demo/issues/2#issuecomment-${writes}`,
    });
    if (loseReply) {
      loseReply = false;
      throw new Error('Response lost after committed comment');
    }
    return Response.json(comments.at(-1), { status: 201 });
  };
  return {
    board: new Board(
      new Octokit({
        request: { fetch: fetcher },
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
      configSchema.parse({ board_repo: 'Contoso/demo' }),
    ),
    comments,
    writes: () => writes,
  };
}
const id = '11111111-1111-4111-8111-111111111111';

it('locks publication preparation before its first await and refuses overlapping context changes', async () => {
  const lock = new PublicationLock();
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publication = lock.run(async () => {
    await waiting;
    return 'session A';
  });
  try {
    expect(lock.busy).toBe(true);
    await expect(lock.run(async () => 'session B')).rejects.toThrow(
      /publication.*progress/i,
    );
  } finally {
    release();
  }
  expect(await publication).toBe('session A');
  expect(lock.busy).toBe(false);
});

it('releases a failed publication preparation so another reviewed operation can proceed', async () => {
  const lock = new PublicationLock();
  await expect(
    lock.run(async () => {
      throw new Error('Synthetic preflight failed.');
    }),
  ).rejects.toThrow('Synthetic preflight failed.');
  expect(lock.busy).toBe(false);
  expect(await lock.run(async () => 'retry')).toBe('retry');
});

it('includes every outgoing evidence excerpt in the recovered human-review preview', () => {
  const text = pendingReviewText({
    id,
    kind: 'evidence',
    repo: 'Contoso/demo',
    actor: 'tester',
    session: id,
    synthetic: true,
    at: '2026-11-20T12:00:00Z',
    issue: 2,
    note: 'Synthetic reviewed note.',
    step: 'Confirm challenge',
    capture: {
      id,
      image: 'data:image/png;base64,AA==',
      source: 'Synthetic screen',
      capturedAt: '2026-11-20T12:00:00Z',
      width: 1,
      height: 1,
      transcript: 'Synthetic transcript that must be reviewed before retry.',
    },
  });
  expect(text).toContain(
    'Synthetic transcript that must be reviewed before retry.',
  );
  expect(text).toContain('Synthetic reviewed note.');
  expect(text).toContain('Confirm challenge');
  expect(text).not.toContain('base64');
});

it('recovers a committed comment after a lost reply without rerunning authorization or writing twice', async () => {
  const f = fixture();
  const authorize = vi.fn(async () => undefined);
  await expect(
    postReviewedComment(
      f.board,
      2,
      id,
      'tester',
      '/validate Synthetic MFA observed.',
      authorize,
    ),
  ).rejects.toThrow(/lost/);
  const url = await postReviewedComment(
    f.board,
    2,
    id,
    'tester',
    '/validate Synthetic MFA observed.',
    authorize,
  );
  expect(url).toContain('issuecomment-1');
  expect(f.writes()).toBe(1);
  expect(authorize).toHaveBeenCalledTimes(1);
});

it('rejects an edited retry and never accepts a matching receipt from a different actor', async () => {
  const f = fixture();
  await expect(
    postReviewedComment(
      f.board,
      2,
      id,
      'tester',
      '/validate Synthetic.',
      async () => undefined,
    ),
  ).rejects.toThrow(/lost/);
  await expect(
    postReviewedComment(
      f.board,
      2,
      id,
      'tester',
      '/approve',
      async () => undefined,
    ),
  ).rejects.toThrow(/changed|immutable/);
  const existing = f.comments[0];
  if (!existing?.user) throw new Error('Missing fixture receipt');
  existing.user.login = 'outsider';
  const authorize = vi.fn(async () => undefined);
  await postReviewedComment(
    f.board,
    2,
    id,
    'tester',
    '/validate Synthetic.',
    authorize,
  );
  expect(f.writes()).toBe(2);
  expect(authorize).toHaveBeenCalledTimes(1);
});
