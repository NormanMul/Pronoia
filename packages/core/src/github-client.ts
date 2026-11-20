import { Octokit } from 'octokit';

export const githubFetch: typeof fetch = (input, init) => {
  const deadline = AbortSignal.timeout(15000);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
  });
};

export function createGitHubClient(token: string): Octokit {
  if (!token) throw new Error('A GitHub credential is required.');
  return new Octokit({
    auth: token,
    userAgent: 'pronoia/0.1.0',
    request: { fetch: githubFetch },
    headers: { 'x-github-api-version': '2026-03-10' },
    retry: { retries: 2 },
  });
}
