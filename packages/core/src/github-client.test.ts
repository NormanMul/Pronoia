import { afterEach, expect, it, vi } from 'vitest';
import { createGitHubClient, githubFetch } from './github-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('creates a fresh deadline per request and preserves caller cancellation', async () => {
  const deadlines: AbortController[] = [];
  const signals: AbortSignal[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  vi.stubGlobal('fetch', (_input: unknown, init: RequestInit) => {
    const signal = init.signal;
    if (!signal) throw new Error('Missing request deadline');
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const caller = new AbortController();
  const first = githubFetch('https://api.github.com/repos/Contoso/demo');
  const second = githubFetch('https://api.github.com/repos/Contoso/demo', {
    signal: caller.signal,
  });
  expect(signals[0]).not.toBe(signals[1]);
  deadlines[0]?.abort(new Error('deadline'));
  await expect(first).rejects.toThrow('deadline');
  expect(signals[1]?.aborted).toBe(false);
  caller.abort(new Error('caller cancelled'));
  await expect(second).rejects.toThrow('caller cancelled');
});

it('installs the bounded fetch hook on the real Octokit client', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_input: unknown, init: RequestInit) => {
    if (!init.signal) throw new Error('Missing request deadline');
    signals.push(init.signal);
    return Promise.resolve(
      new Response(JSON.stringify({ private: false }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const client = createGitHubClient('test-only-placeholder');
  await client.rest.repos.get({ owner: 'Contoso', repo: 'demo' });
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
});
