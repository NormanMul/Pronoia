import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commentSchema, marker, type Board } from '@pronoia/core';
import { DesktopError } from './safety';
import type { ReviewedAction } from './local-review';

export class PublicationLock {
  private active = false;

  get busy(): boolean {
    return this.active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new DesktopError(
        'PUBLICATION_BUSY',
        'Another reviewed publication is in progress; retry when it finishes.',
      );
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}

export function pendingReviewText(action: ReviewedAction): string {
  if (action.kind === 'manual') return action.body;
  if (action.kind === 'recap') return action.text;
  return JSON.stringify(
    {
      kind: action.kind,
      repository: action.repo,
      actor: action.actor,
      issue: action.issue,
      ...(action.kind === 'proposal'
        ? { proposal: action.proposal }
        : { note: action.note, step: action.step }),
      capture: {
        capturedAt: action.capture.capturedAt,
        source: action.capture.source,
        transcript: action.capture.transcript,
      },
    },
    null,
    2,
  );
}

export async function postReviewedComment(
  board: Board,
  issue: number,
  id: string,
  actor: string,
  body: string,
  authorize: () => Promise<void>,
): Promise<string> {
  z.uuid().parse(id);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const expected = `${body}\n\n${marker('desktop-publication', { id, sha256 })}`;
  for (const comment of await board.comments(issue)) {
    if (comment.user?.login.toLowerCase() !== actor.toLowerCase()) continue;
    const match = /<!-- pronoia:desktop-publication (.*?) -->/s.exec(
      comment.body,
    );
    if (!match?.[1]) continue;
    const receipt = z
      .object({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(JSON.parse(match[1]));
    if (receipt.id !== id) continue;
    if (receipt.sha256 !== sha256 || comment.body !== expected) {
      throw new DesktopError(
        'PUBLICATION_CHANGED',
        'The previously reviewed publication changed; it cannot be replayed with edited content.',
      );
    }
    return comment.html_url;
  }
  await authorize();
  const response = await board.api.rest.issues.createComment({
    ...board.scope,
    issue_number: issue,
    body: expected,
    request: { retries: 0 },
  });
  const published = commentSchema.parse(response.data);
  if (published.user?.login.toLowerCase() !== actor.toLowerCase()) {
    throw new DesktopError(
      'PUBLICATION_ACTOR',
      'GitHub did not confirm the signed-in publication actor.',
    );
  }
  return published.html_url;
}
