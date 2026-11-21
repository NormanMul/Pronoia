import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@azure/identity');
  vi.resetModules();
});

it('keeps Azure Identity unloaded when importing offline integrations', async () => {
  const loadIdentity = vi.fn(() => ({ DefaultAzureCredential: class {} }));
  vi.doMock('@azure/identity', loadIdentity);
  const { uploadSharePoint } = await import('./integrations.js');
  expect((await uploadSharePoint('unused', { env: {} })).status).toBe(
    'skipped',
  );
  expect(loadIdentity).not.toHaveBeenCalled();
});
