import { expect, it } from 'vitest';
import { SessionBudget } from './budget';
import { publicSettingsSchema } from './shared';

it('accepts the full validated desktop settings without treating other connection fields as limits', () => {
  const settings = publicSettingsSchema.parse({
    endpoint: '',
    chatDeployment: '',
    transcribeDeployment: '',
    realtimeDeployment: '',
    githubRepo: 'Contoso/demo',
    exportDir: 'C:\\Synthetic\\exports',
    hasKey: false,
    hasGitHubToken: false,
  });
  const budget = new SessionBudget(settings);
  expect(() =>
    budget.claim({ image: false, tokens: 100, at: 0 }).complete(100),
  ).not.toThrow();
});

const limits = {
  maxImagesPerSession: 4,
  maxAnalysesPerMinute: 3,
  maxTokensPerSession: 32000,
};

it('reserves concurrent calls and charges unknown usage instead of silently assuming zero', () => {
  const budget = new SessionBudget(limits);
  const first = budget.claim({ image: true, tokens: 16000, at: 0 });
  const second = budget.claim({ image: true, tokens: 16000, at: 0 });
  expect(() => budget.claim({ image: false, tokens: 1, at: 0 })).toThrow(
    /budget/i,
  );
  first.complete(1000);
  expect(second.complete(null)).toBe(false);
  expect(budget.tokens).toBe(17000);
  expect(() => budget.claim({ image: false, tokens: 16000, at: 0 })).toThrow(
    /budget/i,
  );
});

it('measures image and rolling rate limits at the exact minute boundary', () => {
  const budget = new SessionBudget({ ...limits, maxImagesPerSession: 3 });
  for (let index = 0; index < 3; index += 1)
    budget.claim({ image: true, tokens: 1, at: 0 }).complete(1);
  expect(() => budget.claim({ image: false, tokens: 1, at: 59999 })).toThrow(
    /rate/i,
  );
  expect(() =>
    budget.claim({ image: false, tokens: 1, at: 60000 }).complete(1),
  ).not.toThrow();
  expect(() => budget.claim({ image: true, tokens: 1, at: 60000 })).toThrow(
    /image/i,
  );
});

it('keeps measured over-budget usage and refuses duplicate or invalid settlements', () => {
  const budget = new SessionBudget(limits);
  const claim = budget.claim({ image: false, tokens: 16000, at: 0 });
  expect(() => claim.complete(-1)).toThrow();
  expect(() => claim.complete(32001)).toThrow(/budget/i);
  expect(budget.tokens).toBe(32001);
  expect(() => claim.complete(1)).toThrow(/settled/i);
  expect(() => budget.claim({ image: false, tokens: 1, at: 60000 })).toThrow(
    /budget/i,
  );
});
