import { z } from 'zod';

export const statusSchema = z.enum([
  'todo',
  'in-progress',
  'validate',
  'blocked',
  'done',
]);
export const severitySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
export const sourceSchema = z.enum([
  'checklist',
  'dependabot',
  'code-scanning',
  'secret-scanning',
  'sarif',
  'session',
  'manual',
]);
export const disputeSchema = z.enum([
  'false-positive',
  'not-applicable',
  'risk-accepted',
]);
export const commandSchema = z
  .object({
    name: z.enum([
      'start',
      'validate',
      'approve',
      'reject',
      'dispute',
      'block',
      'unblock',
      'reopen',
      'confirm',
      'assign',
      'severity',
      'due',
      'copilot',
      'ai',
    ]),
    reason: z.string().max(10000).default(''),
    validatedBy: z.string().max(300).default(''),
    disputeType: disputeSchema.optional(),
    until: z.iso.date().optional(),
    assignee: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
      .optional(),
    severity: severitySchema.optional(),
    due: z.iso.date().optional(),
    aiMode: z
      .enum(['triage', 'remediate', 'test-plan', 'summarize'])
      .optional(),
  })
  .strict();

export const stateSchema = z.object({
  status: statusSchema.default('todo'),
  assignees: z.array(z.string()).default([]),
  pr_authors: z.array(z.string()).default([]),
  evidence_count: z.number().int().nonnegative().default(0),
  evidence_required: z.boolean().default(true),
  has_merged_pr: z.boolean().default(false),
  alert_fixed: z.boolean().default(false),
  validation_requested_by: z.string().nullable().default(null),
  validation_requested_at: z.iso.datetime().nullable().default(null),
  validated_by: z.string().nullable().default(null),
  validated_by_name: z.string().nullable().default(null),
  validated_at: z.iso.datetime().nullable().default(null),
  previous_status: statusSchema.nullable().default(null),
  blocked_reason: z.string().nullable().default(null),
  pending_dispute: disputeSchema.nullable().default(null),
  dispute_type: disputeSchema.nullable().default(null),
  dispute_reason: z.string().nullable().default(null),
  disputed_by: z.string().nullable().default(null),
  risk_until: z.iso.date().nullable().default(null),
  reject_count: z.number().int().nonnegative().default(0),
  last_reject_reason: z.string().nullable().default(null),
  last_reject_by: z.string().nullable().default(null),
  resolution: z
    .enum(['fixed', ...disputeSchema.options])
    .nullable()
    .default(null),
  confirmed_by: z.string().nullable().default(null),
  severity: severitySchema.default('medium'),
  due_date: z.iso.date().nullable().default(null),
});

export const auditSchema = z.object({
  from: statusSchema,
  to: statusSchema,
  command: commandSchema,
  actor: z.string().min(1),
  actor_type: z.enum(['human', 'agent', 'automation']),
  on_behalf_of: z.string(),
  reason: z.string(),
  evidence_count: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  comment_id: z.number().int().positive(),
  audit_comment_id: z.number().int().positive().optional(),
  effect_comment_id: z.number().int().positive().optional(),
  before_state: stateSchema.optional(),
  failure_reason: z.string().max(1000).optional(),
  state: stateSchema,
});

export type Status = z.infer<typeof statusSchema>;
export type Command = z.infer<typeof commandSchema>;
export type WorkflowState = z.infer<typeof stateSchema>;
export type Audit = z.infer<typeof auditSchema>;
export type Actor = {
  login: string;
  association: string;
  userType: 'User' | 'Bot';
  agent?: string;
};
