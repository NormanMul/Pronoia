import { expect, it } from 'vitest';
import {
  requireConsent,
  requirePublication,
  screenChanged,
  redactText,
  allowedExternalUrl,
  requireCurrentOperation,
  requireCaptureToken,
} from './safety';

it('requires participant notice and cloud-processing consent for each new session', () => {
  expect(() =>
    requireConsent({ participantsNotified: false, cloudApproved: true }),
  ).toThrow(/consent/i);
  expect(() =>
    requireConsent({ participantsNotified: true, cloudApproved: false }),
  ).toThrow(/consent/i);
  expect(() =>
    requireConsent({ participantsNotified: true, cloudApproved: true }),
  ).not.toThrow();
});

it('refuses late capture/model results after Pause-resume or a different session starts', () => {
  const old = new AbortController();
  old.abort();
  const resumed = new AbortController();
  expect(() => requireCurrentOperation('old', 'old', old.signal)).toThrow(
    /cancel/i,
  );
  expect(() => requireCurrentOperation('old', 'new', resumed.signal)).toThrow(
    /session/i,
  );
  expect(() =>
    requireCurrentOperation('new', 'new', resumed.signal),
  ).not.toThrow();
});

it('refuses queued audio from the previous capture generation after a resume', () => {
  expect(() => requireCaptureToken('resumed', 'before-pause')).toThrow(
    /capture|paused/i,
  );
  expect(() => requireCaptureToken('resumed', 'resumed')).not.toThrow();
});

it('rejects unreviewed uploads and real-data uploads to public evidence branches', () => {
  expect(() => requirePublication(true, false, true)).toThrow(/review/i);
  expect(() => requirePublication(true, true, false)).toThrow(
    /synthetic|public/i,
  );
  expect(() => requirePublication(false, true, false)).not.toThrow();
});

it('queues changed frames only when the measured change reaches the threshold', () => {
  expect(
    screenChanged(new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 1])),
  ).toBe(false);
  expect(
    screenChanged(new Uint8Array([0, 0, 0]), new Uint8Array([10, 10, 10])),
  ).toBe(true);
  expect(() =>
    screenChanged(new Uint8Array([0]), new Uint8Array([0, 0])),
  ).toThrow();
});

it('redacts recognizable credentials and contact data before text is uploaded', () => {
  expect(
    redactText(
      'Contact demo@example.test; ghp_abcdefghijklmnopqrstuvwx1234567890',
    ),
  ).not.toContain('demo@example.test');
  expect(redactText('ghp_abcdefghijklmnopqrstuvwx1234567890')).not.toContain(
    'ghp_',
  );
  expect(redactText('Contoso MFA test is complete.')).toBe(
    'Contoso MFA test is complete.',
  );
  expect(redactText('Due 2026-11-20; CVE-2026-123456789.')).toBe(
    'Due 2026-11-20; CVE-2026-123456789.',
  );
});

it('allows explicit approved HTTPS references, not arbitrary navigation or credential URLs', () => {
  expect(
    allowedExternalUrl('https://github.com/NormanMul/Pronoia/issues/2'),
  ).toBe(true);
  for (const url of [
    'javascript:alert(1)',
    'file:///C:/private',
    'https://github.com.evil.test/',
    'https://user:password@github.com/',
  ])
    expect(allowedExternalUrl(url)).toBe(false);
});
