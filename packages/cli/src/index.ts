#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  assessmentRows,
  Board,
  configSchema,
  isAuditWriter,
  createGitHubClient,
  type Config,
} from '@pronoia/core';

if (existsSync('.env')) process.loadEnvFile('.env');

function config(): Config {
  const filename = resolve('pronoia.config.yml');
  const contents: unknown = existsSync(filename)
    ? parse(readFileSync(filename, 'utf8'))
    : {};
  const parsed = configSchema.parse(contents);
  return configSchema.parse({
    ...parsed,
    board_repo:
      process.env.PRONOIA_REPO ||
      process.env.GITHUB_REPOSITORY ||
      parsed.board_repo,
    export: { dir: process.env.PRONOIA_EXPORT_DIR || parsed.export.dir },
  });
}

function board(): Board {
  const token =
    process.env.GITHUB_TOKEN ||
    execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (!token)
    throw new Error('Authenticate with gh auth login or set GITHUB_TOKEN.');
  return new Board(createGitHubClient(token), config());
}

function writerIssue(options: { issue?: string }): number {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      'Authoritative status writes run only in GitHub Actions. Use comment.',
    );
  }
  if (options.issue)
    return z.coerce.number().int().positive().parse(options.issue);
  const filename = process.env.GITHUB_EVENT_PATH;
  if (!filename) throw new Error('GITHUB_EVENT_PATH is missing.');
  return z
    .object({ issue: z.object({ number: z.number().int().positive() }) })
    .parse(JSON.parse(readFileSync(filename, 'utf8'))).issue.number;
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function importFile(
  file: string,
  assessment: string,
  options: { dryRun?: boolean; synthetic?: boolean; milestone?: string },
): Promise<void> {
  const rows = assessmentRows(readFileSync(resolve(file), 'utf8'));
  if (options.dryRun) {
    output({
      dry_run: true,
      planned: rows.length,
      issues: rows.map((row) => ({
        test_id: row.test_id,
        title: row.title,
        severity: row.severity,
        status: 'todo',
      })),
    });
    return;
  }
  output(await board().importAssessment(rows, assessment, options));
}

const program = new Command()
  .name('pronoia')
  .description(
    'AI proposes; humans validate. GitHub comments are authoritative.',
  )
  .version('0.1.0');

program
  .command('setup')
  .description('Create board labels and enable native scanners where permitted')
  .action(async () => {
    const client = board();
    await client.setupLabels(['assessment:manual']);
    const features: { feature: string; enabled: boolean; reason?: string }[] =
      [];
    const steps = [
      {
        feature: 'Dependabot alerts',
        route: 'PUT /repos/{owner}/{repo}/vulnerability-alerts',
        data: {},
      },
      {
        feature: 'Dependabot security updates',
        route: 'PUT /repos/{owner}/{repo}/automated-security-fixes',
        data: {},
      },
      {
        feature: 'Secret scanning and push protection',
        route: 'PATCH /repos/{owner}/{repo}',
        data: {
          security_and_analysis: {
            secret_scanning: { status: 'enabled' },
            secret_scanning_push_protection: { status: 'enabled' },
          },
        },
      },
      {
        feature: 'CodeQL default setup',
        route: 'PATCH /repos/{owner}/{repo}/code-scanning/default-setup',
        data: {
          state: 'configured',
          languages: ['javascript-typescript'],
          query_suite: 'default',
        },
      },
    ];
    for (const step of steps) {
      try {
        await client.api.request(step.route, { ...client.scope, ...step.data });
        features.push({ feature: step.feature, enabled: true });
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('status' in error) ||
          ![403, 404, 422].includes(Number(error.status))
        )
          throw error;
        const reason = `Unavailable or not permitted (HTTP ${String(error.status)}).`;
        console.warn(`${step.feature}: ${reason}`);
        features.push({ feature: step.feature, enabled: false, reason });
      }
    }
    output({ labels: 'ready', features });
  });

program
  .command('import')
  .argument('<csv>')
  .requiredOption('--assessment <name>')
  .option('--milestone <name>')
  .option('--dry-run')
  .option(
    '--synthetic',
    'Confirm all imported data is synthetic, required for public boards',
  )
  .action(
    (
      file: string,
      options: {
        assessment: string;
        milestone?: string;
        dryRun?: boolean;
        synthetic?: boolean;
      },
    ) => importFile(file, options.assessment, options),
  );

program
  .command('demo-seed')
  .option('--dry-run')
  .action((options: { dryRun?: boolean }) => {
    const sample = fileURLToPath(
      new URL('../../../assessments/security-readiness.csv', import.meta.url),
    );
    return importFile(sample, 'Security Readiness - Contoso', {
      dryRun: options.dryRun,
      synthetic: true,
      milestone: 'Contoso demonstration',
    });
  });

program
  .command('apply-command')
  .option('--issue <number>')
  .action(async (options: { issue?: string }) => {
    output(await board().applyCommands(writerIssue(options)));
  });

program
  .command('guard')
  .option('--issue <number>')
  .action(async (options: { issue?: string }) => {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (eventPath) {
      const event = z
        .object({ sender: z.object({ login: z.string() }) })
        .passthrough()
        .parse(JSON.parse(readFileSync(eventPath, 'utf8')));
      if (isAuditWriter(event.sender.login)) {
        output({ skipped: 'Authorized automation identity.' });
        return;
      }
    }
    await board().guard(writerIssue(options));
    output({ guard: 'checked' });
  });

program
  .command('comment')
  .requiredOption('--issue <number>')
  .requiredOption('--body <text>')
  .option(
    '--agent <name>',
    'Stamp an agent identity even when using a human token',
  )
  .action(async (options: { issue: string; body: string; agent?: string }) => {
    const comment = await board().comment(
      z.coerce.number().int().positive().parse(options.issue),
      options.body,
      options.agent || process.env.PRONOIA_AGENT_NAME || undefined,
    );
    output({ comment: comment.html_url });
  });

program
  .command('evidence')
  .command('add')
  .requiredOption('--issue <number>')
  .requiredOption('--file <png>')
  .requiredOption('--note <text>')
  .option('--source <name>', 'Capture source', 'CLI')
  .option('--session <id>')
  .option('--step <name>')
  .option('--reviewed', 'Confirm this image has been reviewed and redacted')
  .option(
    '--synthetic',
    'Confirm this screenshot is synthetic, required for public boards',
  )
  .option('--agent <name>')
  .action(
    async (options: {
      issue: string;
      file: string;
      note: string;
      source: string;
      session?: string;
      step?: string;
      reviewed?: boolean;
      synthetic?: boolean;
      agent?: string;
    }) => {
      const number = z.coerce.number().int().positive().parse(options.issue);
      const png = readFileSync(resolve(options.file));
      const meta = await board().addEvidence(
        number,
        png,
        {
          ...options,
          reviewed: options.reviewed === true,
          synthetic: options.synthetic === true,
        },
        options.agent || process.env.PRONOIA_AGENT_NAME || undefined,
      );
      const folder = join(config().export.dir, 'evidence', String(number));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, basename(meta.file)), png);
      output(meta);
    },
  );

await program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Unexpected Pronoia CLI error.',
  );
  process.exitCode = 1;
});
