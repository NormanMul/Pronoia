import { z } from 'zod';

export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(
    (repo) => !repo.split('/').some((part) => part === '.' || part === '..'),
  );

const loginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/);

export const configSchema = z
  .object({
    board_repo: repoSchema.default('NormanMul/Pronoia'),
    timezone: z.literal('Asia/Jakarta').default('Asia/Jakarta'),
    governance: z
      .object({
        four_eyes: z.literal(true).default(true),
        allow_self_approve: z.literal(false).default(false),
        evidence_required_for_approve: z.literal(true).default(true),
        automation_logins: z.array(loginSchema).default([]),
        approvers: z.array(loginSchema).optional(),
      })
      .prefault({}),
    project: z
      .object({
        owner: loginSchema,
        number: z.number().int().positive(),
        field: z.string().default('Stage'),
      })
      .optional(),
    targets: z
      .array(
        z.object({ repo: repoSchema, assessment: z.string().min(1).max(200) }),
      )
      .default([]),
    priority: z
      .object({
        p1_cvss: z.number().min(0).max(10).default(9),
        p1_epss: z.number().min(0).max(1).default(0.5),
        p2_cvss: z.number().min(0).max(10).default(7),
        p2_epss: z.number().min(0).max(1).default(0.1),
        p3_cvss: z.number().min(0).max(10).default(4),
      })
      .prefault({}),
    sla_days: z
      .object({
        p1: z.number().int().positive().default(7),
        p2: z.number().int().positive().default(14),
        p3: z.number().int().positive().default(30),
        p4: z.number().int().positive().default(90),
      })
      .prefault({}),
    budgets: z
      .object({
        max_analyses_per_min: z.number().int().min(1).max(6).default(3),
        max_images_per_session: z.number().int().positive().default(60),
      })
      .prefault({}),
    retention_days: z.number().int().min(1).max(365).default(30),
    keep_audio: z.literal(false).default(false),
    auto_dismiss: z.boolean().default(false),
    export: z.object({ dir: z.string().default('exports') }).prefault({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
