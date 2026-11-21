import { expect, it } from 'vitest';
import { roleSchemas } from '@pronoia/core';
import { formatRecap } from './recap';

it('retains structured verbal speaker, timestamp and quote as non-authoritative observations', () => {
  const recap = roleSchemas.Scribe.parse({
    recap: 'No assessment approvals were recorded.',
    verbal_decisions: [
      {
        type: 'approve',
        speaker: 'Contoso reviewer',
        quote: 'The synthetic MFA challenge appeared.',
        at: '2026-11-20T12:00:00Z',
      },
    ],
    follow_ups: ['A different human must review the evidence.'],
    requires_human_review: true,
  });
  const text = formatRecap(recap);
  expect(text).toContain('Contoso reviewer');
  expect(text).toContain('2026-11-20T12:00:00Z');
  expect(text).toContain('The synthetic MFA challenge appeared.');
  expect(text).toMatch(/non-authoritative/i);
  expect(text).toContain('No assessment approvals were recorded.');
});
