import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { expect, it } from 'vitest';

const workflowSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  jobs: z.record(
    z.string(),
    z.object({
      permissions: z.record(z.string(), z.string()).optional(),
      concurrency: z
        .object({
          group: z.string(),
          'cancel-in-progress': z.boolean().optional(),
          queue: z.enum(['single', 'max']).optional(),
        })
        .optional(),
      steps: z
        .array(
          z.object({
            name: z.string().optional(),
            run: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        )
        .optional(),
    }),
  ),
});
function workflow(name: string) {
  return workflowSchema.parse(
    parse(
      readFileSync(
        new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
        'utf8',
      ),
    ),
  );
}

it('queues all serialized discovery/ingestion jobs instead of replacing pending SARIF work', () => {
  const scan = workflow('scan');
  const sync = workflow('sync-security');
  expect(scan.jobs.ingest?.concurrency?.queue).toBe('max');
  expect(sync.jobs.discover?.concurrency?.queue).toBe('max');
  expect(scan.jobs.ingest?.concurrency?.group).toBe(
    sync.jobs.discover?.concurrency?.group,
  );
  expect(scan.jobs.ingest?.concurrency?.['cancel-in-progress']).toBe(false);
  expect(sync.jobs.discover?.concurrency?.['cancel-in-progress']).toBe(false);
});

it('grants scanner planning/ingestion only the scopes those jobs actually use', () => {
  const scan = workflow('scan');
  expect(scan.jobs.targets?.permissions).toEqual({ contents: 'read' });
  expect(scan.jobs.ingest?.permissions?.['security-events']).toBeUndefined();
});

it('guards checkout board-token fallback with the verified own-public target flag', () => {
  const token = workflow('scan').jobs.scan?.steps?.find((step) =>
    step.name?.startsWith('Read target'),
  )?.with?.token;
  expect(token).toEqual(expect.stringContaining('matrix.allow_board_token'));
});

it('persists manual AI requests before dispatch rather than relying on a replaceable issue-worker job', () => {
  const request = workflow('ai').jobs.request;
  expect(
    request?.steps?.some(
      (step) =>
        step.run?.includes('queue-ai') && step.run.includes('--dispatch'),
    ),
  ).toBe(true);
});

it.each(['scan', 'sync-security', 'commands'])(
  'supports READ App/PAT aliases in %s without aliasing the authoritative writer or dismissal token',
  (name) => {
    const definition = workflow(name);
    expect(
      definition.env?.PRONOIA_READ_APP_ID?.match(
        /(?:vars|secrets)\.PRONOIA(?:_READ)?_APP_ID/g,
      ),
    ).toEqual([
      'vars.PRONOIA_READ_APP_ID',
      'secrets.PRONOIA_READ_APP_ID',
      'vars.PRONOIA_APP_ID',
      'secrets.PRONOIA_APP_ID',
    ]);
    const jobs = definition.jobs;
    const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
    for (const step of steps.filter(
      (entry) => entry.with?.['app-id'] !== undefined,
    )) {
      expect(step.with?.['app-id']).toBe('${{ env.PRONOIA_READ_APP_ID }}');
      expect(step.with?.['private-key']).toEqual(
        expect.stringContaining(
          'secrets.PRONOIA_READ_APP_PRIVATE_KEY || secrets.PRONOIA_APP_PRIVATE_KEY',
        ),
      );
    }
    for (const step of steps.filter(
      (entry) => entry.env?.PRONOIA_TARGET_TOKEN !== undefined,
    )) {
      expect(step.env?.PRONOIA_TARGET_TOKEN).toContain(
        'secrets.PRONOIA_TARGET_TOKEN || secrets.PRONOIA_SCAN_TOKEN',
      );
      expect(step.env?.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
      if (step.env?.PRONOIA_DISMISS_TOKEN)
        expect(step.env.PRONOIA_DISMISS_TOKEN).toBe(
          '${{ secrets.PRONOIA_DISMISS_TOKEN }}',
        );
    }
  },
);
