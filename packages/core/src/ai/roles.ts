import { z } from 'zod';
import { severitySchema } from '../workflow/schemas.js';

const prose = z.string().max(6000);
const short = z.string().max(1000);
const steps = z.array(short).max(7);
const confidence = z.number().min(0).max(1);
const issue = z.number().int().positive().nullable();
const result = z.enum(['pass', 'fail', 'unclear', 'n/a']);
const references = z.array(z.url({ protocol: /^https$/ })).max(20);
export const verbalDecisionSchema = z
  .object({
    type: z.enum(['approve', 'reject', 'dispute', 'none']),
    speaker: z.string().max(200),
    quote: short,
    at: z.string().max(100),
  })
  .strict();

export const analystSchema = z
  .object({
    issue,
    observed: prose,
    result,
    proposed_command: z.enum([
      '/start',
      '/validate',
      '/block',
      '/confirm',
      'none',
    ]),
    reason: short,
    remediation: steps,
    evidence_note: prose,
    verbal_decision: verbalDecisionSchema,
    confidence,
  })
  .strict();
export type AnalystOutput = z.infer<typeof analystSchema>;

export const roleSchemas = {
  Intake: z
    .object({
      assessment: z.string().min(1).max(200),
      summary: prose,
      issues: z
        .array(
          z
            .object({
              test_id: z.string().min(1).max(100),
              title: z.string().min(1).max(256),
              description: prose,
              expected_result: prose,
              severity: severitySchema,
              evidence_required: z.literal(true),
            })
            .strict(),
        )
        .max(50),
      warnings: z.array(short).max(20),
    })
    .strict(),
  Triage: z
    .object({
      summary: prose,
      priority: z.enum(['p1', 'p2', 'p3', 'p4']).nullable(),
      reason: short,
      remediation: steps,
      references,
      confidence,
    })
    .strict(),
  Listener: z
    .object({
      transcript: z.string().max(30000),
      participants: z.array(z.string().max(200)).max(50),
      verbal_decisions: z.array(verbalDecisionSchema).max(50),
      uncertain: z.array(short).max(20),
    })
    .strict(),
  Analyst: analystSchema,
  Coach: z.object({ answer: prose, references, confidence }).strict(),
  Verifier: z
    .object({
      issue,
      result,
      checks: z
        .array(
          z
            .object({ name: short, expected: short, observed: short, result })
            .strict(),
        )
        .max(20),
      evidence_note: prose,
      confidence,
    })
    .strict(),
  Scribe: z
    .object({
      recap: prose,
      verbal_decisions: z.array(verbalDecisionSchema).max(50),
      follow_ups: steps,
      requires_human_review: z.literal(true),
    })
    .strict(),
};
export type Role = keyof typeof roleSchemas;
export type RoleOutput<R extends Role> = z.infer<(typeof roleSchemas)[R]>;
