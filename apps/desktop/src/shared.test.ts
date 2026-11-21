import { expect, it } from 'vitest';
import {
  audioSchema,
  proposalSchema,
  publicSettingsSchema,
  settingsInputSchema,
  postProposalSchema,
} from './shared';

const proposal = {
  issue: 2,
  observed: 'Synthetic MFA challenge appeared.',
  result: 'pass',
  proposed_command: '/validate',
  reason: 'Observed expected challenge.',
  remediation: [],
  evidence_note: 'Reviewed synthetic image.',
  verbal_decision: { type: 'none', speaker: '', quote: '', at: '' },
  confidence: 0.9,
};

it('rejects unsafe AI proposal commands, out-of-range confidence and unknown fields at IPC', () => {
  expect(() =>
    proposalSchema.parse({ ...proposal, proposed_command: '/approve' }),
  ).toThrow();
  expect(() =>
    proposalSchema.parse({ ...proposal, confidence: 1.1 }),
  ).toThrow();
  expect(() => proposalSchema.parse({ ...proposal, actor: 'owner' })).toThrow();
  expect(proposalSchema.parse(proposal).issue).toBe(2);
});

it('bounds raw audio chunks and accepts only known capture sources', () => {
  expect(() =>
    audioSchema.parse({
      session: 's',
      capture: '11111111-1111-4111-8111-111111111111',
      source: 'Meeting',
      bytes: new ArrayBuffer(6 * 1024 * 1024),
    }),
  ).toThrow();
  expect(() =>
    audioSchema.parse({
      session: 's',
      capture: '11111111-1111-4111-8111-111111111111',
      source: 'Other',
      bytes: new ArrayBuffer(10),
    }),
  ).toThrow();
  expect(
    audioSchema.parse({
      session: 's',
      capture: '11111111-1111-4111-8111-111111111111',
      source: 'You',
      bytes: new ArrayBuffer(10),
    }).source,
  ).toBe('You');
});

it('requires explicit review before a proposal can publish its image', () => {
  expect(() =>
    postProposalSchema.parse({ id: 'p', issue: 2, proposal, reviewed: false }),
  ).toThrow();
  expect(() =>
    postProposalSchema.parse({ id: 'p', issue: 3, proposal, reviewed: true }),
  ).toThrow();
});

it('never serializes credential values back into renderer settings', () => {
  expect(() =>
    publicSettingsSchema.parse({
      endpoint: '',
      chatDeployment: '',
      transcribeDeployment: '',
      realtimeDeployment: '',
      githubRepo: 'NormanMul/Pronoia',
      exportDir: '',
      hasKey: false,
      hasGitHubToken: false,
      apiKey: 'must-not-leave-main',
    }),
  ).toThrow();
});

it('validates configurable capture retention and AI limits before saving settings', () => {
  const settings = {
    endpoint: '',
    chatDeployment: '',
    transcribeDeployment: '',
    realtimeDeployment: '',
    githubRepo: 'NormanMul/Pronoia',
    exportDir: '',
    authMode: 'identity',
    retentionDays: 30,
    maxImagesPerSession: 60,
    maxAnalysesPerMinute: 3,
    maxTokensPerSession: 100000,
  };
  expect(settingsInputSchema.parse(settings).retentionDays).toBe(30);
  for (const override of [
    { retentionDays: 0 },
    { retentionDays: 366 },
    { maxImagesPerSession: 0 },
    { maxAnalysesPerMinute: 7 },
    { maxTokensPerSession: -1 },
  ])
    expect(
      settingsInputSchema.safeParse({ ...settings, ...override }).success,
    ).toBe(false);
});
