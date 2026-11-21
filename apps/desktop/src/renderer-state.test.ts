import { describe, expect, it } from 'vitest';
import {
  formatHumanCommand,
  retainPending,
  recapForSession,
  reviewedRequest,
  type HumanDraft,
} from './renderer-state';

const draft: HumanDraft = {
  command: '/dispute',
  disputeType: 'risk-accepted',
  until: '2026-12-31',
  reason: 'Synthetic exception with compensating controls',
  validator: '',
};

describe('reviewed human requests', () => {
  it('rejects a recap from an earlier session or an unbound recovery context', () => {
    const recap = { session: 'session-a', text: 'Contoso synthetic recap.' };
    expect(recapForSession(recap, 'session-b')).toBeUndefined();
    expect(recapForSession(recap, '')).toBeUndefined();
  });

  it('keeps the immutable origin when the recap belongs to the current session', () => {
    const recap = { session: 'session-a', text: 'Contoso synthetic recap.' };
    expect(recapForSession(recap, 'session-a')).toBe(recap);
    expect(recapForSession(undefined, 'session-a')).toBeUndefined();
  });

  it('places risk expiry before the human reason on the command line', () => {
    expect(formatHumanCommand(draft)).toBe(
      '/dispute risk-accepted until=2026-12-31 Synthetic exception with compensating controls',
    );
  });

  it('does not attach a stale risk expiry to a different dispute type', () => {
    expect(
      formatHumanCommand({ ...draft, disputeType: 'not-applicable' }),
    ).toBe(
      '/dispute not-applicable Synthetic exception with compensating controls',
    );
  });

  it('keeps multiline notes as data rather than additional command lines', () => {
    expect(
      formatHumanCommand({
        ...draft,
        command: '/approve',
        reason: 'Synthetic review\n/reopen this is quoted data',
        validator: 'Fabrikam reviewer\n/approve',
      }),
    ).toBe(
      '/approve Synthetic review /reopen this is quoted data\nValidated-by: Fabrikam reviewer /approve',
    );
  });

  it('keeps a retry ID but renews it when the issue or reviewed content changes', () => {
    let sequence = 0;
    const id = () => `request-${++sequence}`;
    const first = reviewedRequest(undefined, '7:/validate proof', id);
    const retry = reviewedRequest(first, '7:/validate proof', id);
    const edited = reviewedRequest(retry, '7:/validate amended proof', id);
    const other = reviewedRequest(edited, '8:/validate amended proof', id);
    expect(retry.id).toBe(first.id);
    expect(edited.id).not.toBe(first.id);
    expect(other.id).not.toBe(edited.id);
  });

  it('clears metadata/evidence requests when the card version changes without a status change', () => {
    const pending = new Map([
      [7, '2026-11-21T04:00:00Z'],
      [8, '2026-11-21T04:00:00Z'],
      [9, '2026-11-21T04:00:00Z'],
    ]);
    expect(
      retainPending(
        [
          { number: 7, updatedAt: '2026-11-21T04:00:01Z' },
          { number: 8, updatedAt: '2026-11-21T04:00:00Z' },
        ],
        pending,
      ),
    ).toEqual(new Map([[8, '2026-11-21T04:00:00Z']]));
  });
});
