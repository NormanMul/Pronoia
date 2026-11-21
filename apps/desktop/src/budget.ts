import { z } from 'zod';
import { publicSettingsSchema, type Settings } from './shared';
import { DesktopError } from './safety';

export const budgetSnapshotSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    recentAnalyses: z.array(z.number().nonnegative()),
  })
  .strict();
type Limits = Pick<
  Settings,
  'maxImagesPerSession' | 'maxAnalysesPerMinute' | 'maxTokensPerSession'
>;

export class SessionBudget {
  private used: z.infer<typeof budgetSnapshotSchema>;
  private reserved = 0;
  private limits: Limits;

  constructor(
    limits: Limits,
    saved = { tokens: 0, images: 0, recentAnalyses: [] as number[] },
  ) {
    this.limits = publicSettingsSchema
      .pick({
        maxImagesPerSession: true,
        maxAnalysesPerMinute: true,
        maxTokensPerSession: true,
      })
      .parse({
        maxImagesPerSession: limits.maxImagesPerSession,
        maxAnalysesPerMinute: limits.maxAnalysesPerMinute,
        maxTokensPerSession: limits.maxTokensPerSession,
      });
    this.used = budgetSnapshotSchema.parse(saved);
  }

  get tokens(): number {
    return this.used.tokens;
  }
  get snapshot(): z.infer<typeof budgetSnapshotSchema> {
    return {
      ...this.used,
      tokens: this.tokens + this.reserved,
      recentAnalyses: [...this.used.recentAnalyses],
    };
  }

  claim(input: {
    image: boolean;
    tokens: number;
    at?: number;
    analysis?: boolean;
  }) {
    const reserved = z.number().int().positive().parse(input.tokens);
    const now = input.at ?? Date.now();
    const recent = this.used.recentAnalyses.filter((at) => at > now - 60000);
    if (
      this.tokens + this.reserved + reserved >
      this.limits.maxTokensPerSession
    ) {
      throw new DesktopError(
        'AI_TOKEN_BUDGET',
        'The session token budget cannot cover another request.',
      );
    }
    if (input.image && this.used.images >= this.limits.maxImagesPerSession) {
      throw new DesktopError(
        'AI_IMAGE_BUDGET',
        'The session image budget is exhausted.',
      );
    }
    if (
      input.analysis !== false &&
      recent.length >= this.limits.maxAnalysesPerMinute
    ) {
      throw new DesktopError(
        'AI_RATE_LIMIT',
        'The rolling analysis rate limit is reached.',
      );
    }
    this.used.recentAnalyses =
      input.analysis === false ? recent : [...recent, now];
    if (input.image) this.used.images += 1;
    this.reserved += reserved;
    let settled = false;
    return {
      complete: (tokens: number | null): boolean => {
        if (settled)
          throw new DesktopError(
            'AI_BUDGET',
            'This request was already settled.',
          );
        const charged =
          tokens === null
            ? reserved
            : z.number().int().nonnegative().parse(tokens);
        settled = true;
        this.reserved -= reserved;
        this.used.tokens += charged;
        if (this.tokens > this.limits.maxTokensPerSession) {
          throw new DesktopError(
            'AI_TOKEN_BUDGET',
            'Reported usage exceeded the session budget; no further AI requests are allowed.',
          );
        }
        return tokens !== null;
      },
    };
  }
}
