import type { Card } from './shared';

export const humanCommands = [
  '/start',
  '/validate',
  '/approve',
  '/reject',
  '/dispute',
  '/block',
  '/unblock',
  '/reopen',
  '/confirm',
] as const;
export type HumanCommand = (typeof humanCommands)[number];
export type DisputeType = 'false-positive' | 'not-applicable' | 'risk-accepted';
export type HumanDraft = {
  command: HumanCommand;
  reason: string;
  validator: string;
  disputeType: DisputeType;
  until: string;
};
export type ReviewedRequest = { id: string; key: string };
export type SessionRecap = { session: string; text: string };

export function recapForSession(
  draft: SessionRecap | undefined,
  session: string,
): SessionRecap | undefined {
  return draft && session && draft.session === session ? draft : undefined;
}

export function formatHumanCommand(draft: HumanDraft): string {
  const reason = draft.reason.trim().replace(/\s+/g, ' ');
  const validator = draft.validator.trim().replace(/\s+/g, ' ');
  const command =
    draft.command === '/dispute'
      ? `/dispute ${draft.disputeType}${draft.disputeType === 'risk-accepted' && draft.until ? ` until=${draft.until}` : ''}`
      : draft.command;
  return `${command}${reason ? ` ${reason}` : ''}${draft.command === '/approve' && validator ? `\nValidated-by: ${validator}` : ''}`;
}

export function reviewedRequest(
  previous: ReviewedRequest | undefined,
  key: string,
  createId: () => string = () => crypto.randomUUID(),
): ReviewedRequest {
  return previous?.key === key ? previous : { id: createId(), key };
}

export function retainPending(
  cards: readonly Pick<Card, 'number' | 'updatedAt'>[],
  pending: ReadonlyMap<number, string>,
): Map<number, string> {
  return new Map(
    [...pending].filter(
      ([number, version]) =>
        cards.find((card) => card.number === number)?.updatedAt === version,
    ),
  );
}
