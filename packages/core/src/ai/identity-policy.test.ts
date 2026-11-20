import { expect, it } from 'vitest';
import { foundryConfig } from './foundry.js';

const environment = {
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.openai.azure.com',
  FOUNDRY_CHAT_DEPLOYMENT: 'configured-chat',
  AZURE_FOUNDRY_API_KEY: 'test-only-fallback',
};

it.each([undefined, '', 'identity'])(
  'prefers identity with mode %s even when a fallback key exists',
  (mode) => {
    const result = foundryConfig({ ...environment, AZURE_AUTH_MODE: mode });
    expect(result).toMatchObject({
      ok: true,
      value: { auth: { mode: 'identity' } },
    });
    expect(JSON.stringify(result)).not.toContain('test-only-fallback');
  },
);

it('permits the key only after explicit operator selection', () => {
  expect(
    foundryConfig({ ...environment, AZURE_AUTH_MODE: 'key' }),
  ).toMatchObject({
    ok: true,
    value: { auth: { mode: 'key', apiKey: 'test-only-fallback' } },
  });
  expect(
    foundryConfig({
      ...environment,
      AZURE_AUTH_MODE: 'key',
      AZURE_FOUNDRY_API_KEY: '',
    }),
  ).toMatchObject({ ok: false, error: { code: 'config' } });
});
