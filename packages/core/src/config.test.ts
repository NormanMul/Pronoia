import { expect, it } from 'vitest';
import { configSchema } from './config.js';

it('defaults to strict human validation and private capture retention', () => {
  const config = configSchema.parse({});
  expect(config.governance.four_eyes).toBe(true);
  expect(config.governance.allow_self_approve).toBe(false);
  expect(config.keep_audio).toBe(false);
  expect(config.retention_days).toBe(30);
});

it.each([
  { board_repo: '../other' },
  { retention_days: -1 },
  { keep_audio: true },
  { governance: { automation_logins: ['bad login'] } },
  { priority: { p1_cvss: 11 } },
  { governance: { four_eyes: false } },
  { governance: { allow_self_approve: true } },
  { governance: { evidence_required_for_approve: false } },
])('rejects unsafe config: %j', (value) => {
  expect(() => configSchema.parse(value)).toThrow();
});
