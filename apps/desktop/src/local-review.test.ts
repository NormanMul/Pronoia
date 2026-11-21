import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  appendCsvOnce,
  LocalReviewJournal,
  prunePrivateFiles,
  type ReviewedAction,
} from './local-review';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function journal() {
  const folder = await mkdtemp(path.join(tmpdir(), 'pronoia-review-'));
  folders.push(folder);
  return { folder, journal: await LocalReviewJournal.open(folder) };
}
const action: ReviewedAction = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'manual',
  issue: 2,
  repo: 'Contoso/demo',
  actor: 'tester',
  session: null,
  synthetic: true,
  at: '2026-11-20T12:00:00Z',
  body: '/validate Synthetic MFA observed.',
};

it('purges expired crash snapshots only inside the owned retention namespace', async () => {
  const store = await journal();
  const id = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  await mkdir(path.join(store.folder, 'sessions'));
  const expired = [
    path.join(store.folder, `review.json.${id}.tmp`),
    path.join(store.folder, 'sessions', `${id}.json.${second}.tmp`),
  ];
  const recent = path.join(store.folder, `review.json.${second}.tmp`);
  const other = path.join(store.folder, `unrelated.json.${id}.tmp`);
  for (const file of [...expired, recent, other])
    await writeFile(file, '{"synthetic":true}');
  const at = Date.parse('2026-11-20T12:00:00Z');
  const old = new Date(at - 31 * 86400000);
  for (const file of [...expired, other]) await utimes(file, old, old);
  await prunePrivateFiles(store.folder, 30, at);
  for (const file of expired)
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(recent)).resolves.toBeUndefined();
  await expect(access(other)).resolves.toBeUndefined();
});

it('does not journal a newly refused command before prevalidation succeeds', async () => {
  const store = await journal();
  await expect(
    store.journal.begin(action, async () => {
      throw new Error('Wrong status');
    }),
  ).rejects.toThrow('Wrong status');
  expect(store.journal.state.publications).toHaveLength(0);
  await store.journal.begin(action, async () => undefined);
  expect(store.journal.state.publications).toHaveLength(1);
});

it('serializes concurrent CSV read-modify-write operations without losing a decision', async () => {
  const store = await journal();
  const file = path.join(store.folder, 'decisions.csv');
  await Promise.all([
    appendCsvOnce(file, ['decision', 'reason'], ['first', 'Synthetic one']),
    appendCsvOnce(file, ['decision', 'reason'], ['second', 'Synthetic two']),
  ]);
  const text = await readFile(file, 'utf8');
  expect(text).toContain('first,Synthetic one');
  expect(text).toContain('second,Synthetic two');
});

it('expires private transcript-derived outcomes without deleting published export copies', async () => {
  const store = await journal();
  store.journal.state.outcomes.push({
    id: action.id,
    at: '2026-10-01T12:00:00Z',
    repo: 'Contoso/demo',
    session: action.id,
    agent: 'Analyst',
    issue: 2,
    proposal: 'Expired synthetic verbal quote',
    proposedCommand: '/validate',
    confidence: 0.9,
    outcome: 'accepted',
    reviewer: 'tester',
    reason: 'Synthetic',
  });
  const exported = path.join(store.folder, 'ai-proposals.csv');
  await writeFile(exported, 'published export kept by organization policy');
  store.journal.expire(30, Date.parse('2026-11-20T12:00:00Z'));
  await store.journal.save();
  expect(store.journal.state.outcomes).toHaveLength(0);
  expect(await readFile(exported, 'utf8')).toContain('published export kept');
});

it('persists reviewed intent before effects and rejects edited retries after reopening', async () => {
  const store = await journal();
  await store.journal.begin(action);
  const reopened = await LocalReviewJournal.open(store.folder);
  expect(reopened.state.publications[0]?.action).toMatchObject({
    body: action.body,
  });
  await expect(reopened.begin({ ...action, body: '/approve' })).rejects.toThrow(
    /changed|immutable/i,
  );
  await reopened.finish(
    action.id,
    'https://github.com/Contoso/demo/issues/2#issuecomment-10',
  );
  const completed = await LocalReviewJournal.open(store.folder);
  expect(completed.state.publications[0]?.url).toContain('issuecomment-10');
  expect(
    JSON.parse(await readFile(path.join(store.folder, 'review.json'), 'utf8'))
      .version,
  ).toBe(1);
});

it('preserves other exported outcomes and makes an escaped-row retry idempotent', async () => {
  const store = await journal();
  const filename = path.join(store.folder, 'outcomes.csv');
  await writeFile(filename, '\uFEFFname,reason\r\nold,retained\r\n');
  await appendCsvOnce(
    filename,
    ['name', 'reason'],
    ['new', '=unsafe, "formula"'],
  );
  await appendCsvOnce(
    filename,
    ['name', 'reason'],
    ['new', '=unsafe, "formula"'],
  );
  const csv = await readFile(filename, 'utf8');
  expect(csv).toContain('old,retained');
  expect(csv.match(/new,/g)).toHaveLength(1);
  expect(csv).toContain("'=unsafe");
  await expect(appendCsvOnce(filename, ['different'], ['new'])).rejects.toThrow(
    /schema/i,
  );
});

it('does not treat malformed recovery data as an empty successful session', async () => {
  const store = await journal();
  await writeFile(
    path.join(store.folder, 'review.json'),
    '{"version":1,"session":{"phase":"active"}}',
  );
  await expect(LocalReviewJournal.open(store.folder)).rejects.toThrow();
});
