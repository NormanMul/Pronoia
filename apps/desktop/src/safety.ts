export class DesktopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function requireCurrentOperation(
  expectedSession: string,
  actualSession: string | undefined,
  signal: AbortSignal,
): void {
  if (signal.aborted)
    throw new DesktopError(
      'CANCELLED',
      'The capture or model operation was cancelled.',
    );
  if (expectedSession !== actualSession)
    throw new DesktopError(
      'SESSION_CHANGED',
      'The operation belongs to a different session.',
    );
}

export function requireCaptureToken(expected: string, supplied: string): void {
  if (expected !== supplied)
    throw new DesktopError(
      'CAPTURE_PAUSED',
      'This audio belongs to a previous paused/stopped capture.',
    );
}

export function requireConsent(consent: {
  participantsNotified: boolean;
  cloudApproved: boolean;
}): void {
  if (consent.participantsNotified !== true || consent.cloudApproved !== true) {
    throw new DesktopError(
      'CONSENT_REQUIRED',
      'Participant notice and cloud-processing consent are required for each session.',
    );
  }
}

export function requirePublication(
  publicRepo: boolean,
  reviewed: boolean,
  synthetic: boolean,
): void {
  if (!reviewed)
    throw new DesktopError(
      'REVIEW_REQUIRED',
      'Review and redact the content before uploading.',
    );
  if (publicRepo && !synthetic) {
    throw new DesktopError(
      'PUBLIC_DEMO_ONLY',
      'This public repository accepts synthetic demonstrations only. Use a private, customer-approved repository for real engagements.',
    );
  }
}

export function screenChanged(before: Uint8Array, after: Uint8Array): boolean {
  if (!before.length || before.length !== after.length) {
    throw new DesktopError(
      'FRAME_SIZE',
      'Comparable grayscale frames must have the same nonzero size.',
    );
  }
  let difference = 0;
  for (let i = 0; i < before.length; i += 1) {
    difference += Math.abs((before[i] ?? 0) - (after[i] ?? 0));
  }
  return difference / (before.length * 255) >= 0.02;
}

export function redactText(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[credential redacted]')
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      '[email redacted]',
    )
    .replace(
      /\b(?:api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '[credential redacted]',
    )
    .replace(/(?<![\w-])\+?\d[\d ()-]{8,}\d(?!\w)/g, (value) =>
      value.replace(/\D/g, '').length >= 10 ? '[number redacted]' : value,
    );
}

export function allowedExternalUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    [
      'github.com',
      'docs.github.com',
      'learn.microsoft.com',
      'nvd.nist.gov',
      'www.cisa.gov',
      'www.first.org',
      'api.first.org',
    ].includes(url.hostname)
  );
}
