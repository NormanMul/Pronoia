import type { Command } from 'commander';
import {
  exportBoard,
  publishExports,
  expectedState,
  readMeta,
  statusSchema,
  integrationHooks,
  reconcileProject,
  uploadSharePoint,
  type Board,
  type Config,
  type Issue,
  type WorkflowState,
} from '@pronoia/core';
import { z } from 'zod';
import { actionsOnly } from './security.js';

type Dependencies = {
  config: () => Config;
  board: () => Board;
  output: (value: unknown) => void;
};

export function registerM4Commands(
  program: Command,
  dependencies: Dependencies,
): void {
  program
    .command('board-list')
    .description('Read canonical findings; never writes issue status')
    .option('--assessment <name>')
    .option('--status <status>')
    .option('--limit <number>', 'Maximum returned findings, 1-100', '100')
    .action(
      async (options: {
        assessment?: string;
        status?: string;
        limit: string;
      }) => {
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(options.limit);
        const assessment = z
          .string()
          .min(1)
          .max(200)
          .optional()
          .parse(options.assessment);
        const status = statusSchema.optional().parse(options.status);
        const board = dependencies.board();
        const items: { issue: Issue; state: WorkflowState }[] = [];
        for (const issue of await board.issues()) {
          if (assessment && readMeta(issue.body)?.assessment !== assessment)
            continue;
          const state = expectedState(
            issue,
            await board.comments(issue.number),
            board.config,
          );
          if (status && state.status !== status) continue;
          items.push({ issue, state });
          if (items.length === limit) break;
        }
        dependencies.output({ items });
      },
    );
  program
    .command('item-get')
    .description('Read one finding and its audited state')
    .requiredOption('--issue <number>')
    .action(async (options: { issue: string }) => {
      const number = z.coerce.number().int().positive().parse(options.issue);
      const board = dependencies.board();
      const issue = await board.issue(number);
      if (!issue.labels.includes('pronoia') || issue.pull_request)
        throw new Error('Only existing Pronoia findings may be read.');
      const comments = await board.comments(number);
      dependencies.output({
        issue,
        comments,
        state: expectedState(issue, comments, board.config),
      });
    });
  program
    .command('export')
    .description(
      'Rebuild audited UTF-8 CSVs and verified assets; no issue writes',
    )
    .option('--out <directory>')
    .action(async (options: { out?: string }) => {
      const directory = z
        .string()
        .min(1)
        .max(4096)
        .parse(options.out ?? dependencies.config().export.dir);
      dependencies.output(await exportBoard(dependencies.board(), directory));
    });
  program
    .command('export-publish')
    .description(
      'Publish verified export snapshots from GitHub Actions, without force',
    )
    .option('--out <directory>')
    .action(async (options: { out?: string }) => {
      actionsOnly();
      const directory = z
        .string()
        .min(1)
        .max(4096)
        .parse(options.out ?? dependencies.config().export.dir);
      dependencies.output(
        await publishExports(dependencies.board(), directory),
      );
    });
  program
    .command('integration-sync')
    .description(
      'Mirror audited state and notify configured Teams; Actions only',
    )
    .requiredOption('--issue <number>')
    .action(async (options: { issue: string }) => {
      actionsOnly();
      const issue = z.coerce.number().int().positive().parse(options.issue);
      dependencies.output(
        await integrationHooks(dependencies.board(), issue, {
          projectToken: process.env.PRONOIA_PROJECT_TOKEN || undefined,
          teamsWebhook: process.env.TEAMS_WORKFLOW_WEBHOOK_URL || undefined,
        }),
      );
    });
  program
    .command('project-reconcile')
    .description('Restore optional Project Stage from audited issue state')
    .action(async () => {
      actionsOnly();
      const token = process.env.PRONOIA_PROJECT_TOKEN;
      if (!token || !dependencies.config().project) {
        dependencies.output({
          status: 'skipped',
          reason:
            'Configure project and PRONOIA_PROJECT_TOKEN to enable the mirror.',
        });
        return;
      }
      dependencies.output(await reconcileProject(dependencies.board(), token));
    });
  program
    .command('sharepoint-upload')
    .description(
      'Upload verified snapshots through the configured site-scoped workload identity',
    )
    .option('--out <directory>')
    .action(async (options: { out?: string }) => {
      actionsOnly();
      const directory = z
        .string()
        .min(1)
        .max(4096)
        .parse(options.out ?? dependencies.config().export.dir);
      dependencies.output(
        await uploadSharePoint(directory, { env: process.env }),
      );
    });
}
