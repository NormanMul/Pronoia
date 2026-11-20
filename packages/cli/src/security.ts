import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import {
  Board,
  SecurityAlerts,
  SecurityError,
  Enricher,
  JsonCache,
  ingestDependabot,
  ingestCodeScanning,
  ingestSecretScanning,
  ingestSarif,
  sanitizedSarif,
  repoSchema,
  sarifSchema,
  priorityFor,
  slaDueDate,
  createGitHubClient,
  discoverSecurity,
  importSecurityFindings,
  syncSecurityIssue,
  verifyOnMerge,
  requestManualAi,
  queueManualAi,
  queueMergeIntents,
  consumeIssueIntents,
  type Config,
  type Finding,
} from '@pronoia/core';

type Dependencies = {
  config: () => Config;
  board: () => Board;
  writerIssue: (options: { issue?: string }) => number;
  output: (value: unknown) => void;
};
const samplePath = 'samples/vuln-app';
const sampleAssessment = 'Synthetic vulnerable application';
export function targetReadCredential(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.PRONOIA_TARGET_TOKEN || env.PRONOIA_SCAN_TOKEN;
}
function ownSample(findings: Finding[]): boolean {
  return findings.every(
    (finding) => finding.path?.startsWith(`${samplePath}/`) === true,
  );
}

function actionsOnly(): void {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_TOKEN)
    throw new Error(
      'Authoritative operations require GitHub Actions and its GITHUB_TOKEN.',
    );
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target')
    throw new Error('pull_request_target is not an authorized Pronoia event.');
}

function readJson(file: string): unknown {
  if (statSync(file).size > 20 * 1024 * 1024)
    throw new SecurityError(
      'invalid-data',
      'Security input exceeds the 20 MiB file boundary.',
    );
  return JSON.parse(readFileSync(file, 'utf8'));
}

function save(value: unknown, file?: string): void {
  if (!file) return;
  const path = resolve(file);
  const local = relative(process.cwd(), path);
  if (local.startsWith('..') || isAbsolute(local))
    throw new SecurityError(
      'config',
      'Security output must stay within the current workspace.',
    );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function clients(board: Board) {
  const alerts = new SecurityAlerts(
    board.integrations.targetApi ?? board.api,
    board.integrations.targetApi ? undefined : board.config.board_repo,
  );
  const enricher = new Enricher(
    alerts.api,
    new JsonCache(resolve('.pronoia-cache', 'enrichment')),
    {
      ...(process.env.PRONOIA_NVD_ENABLED === 'true'
        ? { nvd: { apiKey: process.env.NVD_API_KEY || undefined } }
        : {}),
    },
  );
  return { alerts, enricher };
}

function dryPlan(findings: Finding[], config: Config) {
  return {
    dry_run: true,
    planned: findings.length,
    findings: findings.map((finding) => {
      const priority = priorityFor(
        { cvss: finding.cvss, epss: null, kev: null },
        config,
      );
      return {
        ...finding,
        priority,
        due_date: slaDueDate(finding.created_at, priority, config),
        warnings: [
          'Offline preview: EPSS/KEV unavailable; no enrichment score was inferred.',
        ],
      };
    }),
  };
}

async function dispatch(
  board: Board,
  issues: number[],
  mode: 'commands' | 'sync' | 'merge',
  pull?: number,
): Promise<number> {
  for (const issue of new Set(issues)) {
    await board.api.rest.actions.createWorkflowDispatch({
      ...board.scope,
      workflow_id: 'commands.yml',
      ref: 'main',
      inputs: {
        issue: String(issue),
        mode,
        ...(pull ? { pull: String(pull) } : {}),
      },
    });
  }
  return new Set(issues).size;
}

export function registerM2Commands(
  program: Command,
  dependencies: Dependencies,
): void {
  const { config, board, writerIssue, output } = dependencies;
  program
    .command('sync-security')
    .description(
      'Discover/dispatch security work; per-issue processing runs only in Actions',
    )
    .option('--issue <number>')
    .option('--discover')
    .option('--dispatch')
    .option('--fixtures <directory>', 'Synthetic fixture input, dry-run only')
    .option('--dry-run')
    .option('--synthetic')
    .option('--output <file>')
    .action(
      async (options: {
        issue?: string;
        discover?: boolean;
        dispatch?: boolean;
        fixtures?: string;
        dryRun?: boolean;
        synthetic?: boolean;
        output?: string;
      }) => {
        if (options.fixtures) {
          if (!options.dryRun || !options.synthetic)
            throw new SecurityError(
              'privacy',
              'Fixture mode is synthetic offline dry-run only.',
            );
          const repo = config().board_repo;
          const findings = [
            ...ingestDependabot(
              readJson(join(options.fixtures, 'dependabot.json')),
              repo,
            ),
            ...ingestCodeScanning(
              readJson(join(options.fixtures, 'code-scanning.json')),
              repo,
            ),
            ...ingestSecretScanning(
              readJson(join(options.fixtures, 'secret-scanning.json')),
              repo,
            ),
          ];
          const result = dryPlan(findings, config());
          save(result, options.output);
          output(result);
          return;
        }
        if (options.dryRun)
          throw new SecurityError(
            'config',
            'Use --fixtures and --synthetic for an offline preview; live discovery is an Actions operation.',
          );
        actionsOnly();
        const client = board();
        const { alerts, enricher } = clients(client);
        if (options.issue) {
          await consumeIssueIntents(client, alerts, writerIssue(options));
          const result = await syncSecurityIssue(
            client,
            alerts,
            enricher,
            writerIssue(options),
          );
          save(result, options.output);
          output(result);
          return;
        }
        if (!options.discover)
          throw new SecurityError('config', 'Use --discover or --issue.');
        const result = await discoverSecurity(
          client,
          alerts,
          enricher,
          options,
        );
        const dispatched = options.dispatch
          ? await dispatch(client, result.issues, 'sync')
          : 0;
        save(result, options.output);
        output({ ...result, dispatched });
      },
    );

  program
    .command('ingest-sarif')
    .argument('<file>')
    .option('--repo <owner/repo>')
    .option(
      '--assessment <name>',
      'Assessment title',
      'Code Security - Synthetic scanner',
    )
    .option(
      '--base-dir <directory>',
      'Explicit scanner checkout root for relative paths',
    )
    .option(
      '--bundle',
      'Read a normalized scanner bundle with repository metadata',
    )
    .option('--synthetic')
    .option('--dry-run')
    .option('--dispatch')
    .option('--output <file>')
    .action(
      async (
        file: string,
        options: {
          repo?: string;
          assessment: string;
          baseDir?: string;
          bundle?: boolean;
          synthetic?: boolean;
          dryRun?: boolean;
          dispatch?: boolean;
          output?: string;
        },
      ) => {
        const raw = readJson(file);
        const bundle = options.bundle
          ? z
              .object({
                repo: repoSchema,
                assessment: z.string().min(1).max(200),
                synthetic: z.boolean(),
                sample: z.boolean().default(false),
                sarif: sarifSchema,
              })
              .parse(raw)
          : null;
        const repo = repoSchema.parse(
          bundle?.repo ?? options.repo ?? config().board_repo,
        );
        const findings = ingestSarif(
          bundle?.sarif ?? raw,
          repo,
          new Date().toISOString(),
          options.baseDir,
        );
        if (options.dryRun) {
          const result = dryPlan(findings, config());
          save(result, options.output);
          output(result);
          return;
        }
        actionsOnly();
        const client = board();
        const synthetic = bundle?.synthetic ?? options.synthetic === true;
        const targets = client.config.targets.length
          ? client.config.targets.map((target) => target.repo)
          : [client.config.board_repo];
        if (
          !targets.some(
            (target) => target.toLowerCase() === repo.toLowerCase(),
          ) &&
          !(
            bundle?.sample &&
            synthetic &&
            repo.toLowerCase() === client.config.board_repo.toLowerCase() &&
            bundle.assessment === sampleAssessment &&
            ownSample(findings)
          )
        )
          throw new SecurityError(
            'config',
            'SARIF repository must be a configured target.',
          );
        if ((await client.isPublic()) && !synthetic)
          throw new SecurityError(
            'privacy',
            'Public SARIF ingestion requires an explicit synthetic attestation.',
          );
        const { alerts, enricher } = clients(client);
        const visibility = await alerts.visibility(repo);
        if (visibility.private === null) {
          output({ skipped: repo, warnings: [visibility.warning] });
          return;
        }
        const targetPrivate = visibility.private;
        const result = await importSecurityFindings(
          client,
          findings,
          enricher,
          bundle?.assessment ?? options.assessment,
          { synthetic, targetPrivate },
        );
        const dispatched = options.dispatch
          ? await dispatch(client, result.issues, 'sync')
          : 0;
        save(result, options.output);
        output({ ...result, dispatched });
      },
    );

  program
    .command('sanitize-sarif')
    .argument('<file>')
    .requiredOption('--repo <owner/repo>')
    .requiredOption('--assessment <name>')
    .requiredOption('--output <file>')
    .option('--base-dir <directory>')
    .option('--synthetic')
    .option('--sample', 'Attested mandatory own synthetic sample only')
    .action(
      (
        file: string,
        options: {
          repo: string;
          assessment: string;
          output: string;
          baseDir?: string;
          synthetic?: boolean;
          sample?: boolean;
        },
      ) => {
        const sarif = sanitizedSarif(
          readJson(file),
          repoSchema.parse(options.repo),
          options.baseDir,
        );
        if (
          options.sample &&
          (!options.synthetic ||
            options.repo.toLowerCase() !== config().board_repo.toLowerCase() ||
            options.assessment !== sampleAssessment ||
            !ownSample(ingestSarif(sarif, options.repo)))
        )
          throw new SecurityError(
            'privacy',
            'Mandatory sample bundle must contain only attested own sample paths.',
          );
        const bundle = {
          repo: options.repo,
          assessment: z.string().min(1).max(200).parse(options.assessment),
          synthetic: options.synthetic === true,
          sample: options.sample === true,
          sarif,
        };
        save(bundle, options.output);
        save(sarif, `${options.output}.sarif`);
        output({
          sanitized: true,
          findings: sarif.runs[0]?.results.length ?? 0,
        });
      },
    );

  program
    .command('scan-targets')
    .option(
      '--check-public',
      'Fail before checking out private/real targets for a public board',
    )
    .option('--output <file>')
    .action(async (options: { checkPublic?: boolean; output?: string }) => {
      const cfg = config();
      const targets = cfg.targets.length
        ? cfg.targets
        : [
            {
              repo: cfg.board_repo,
              assessment: 'Code Security - Synthetic dogfood',
              synthetic: true,
            },
          ];
      const readable: typeof targets = [];
      let allowBoardToken = false;
      let includeSample = true;
      if (options.checkPublic) {
        actionsOnly();
        const client = board();
        const { alerts } = clients(client);
        const publicBoard = await client.isPublic();
        allowBoardToken = publicBoard;
        for (const target of targets) {
          const visibility = await alerts.visibility(target.repo);
          if (visibility.private === null) {
            console.warn(visibility.warning);
            continue;
          }
          const privateTarget = visibility.private;
          if (
            publicBoard &&
            (privateTarget ||
              (target.repo.toLowerCase() !== cfg.board_repo.toLowerCase() &&
                !target.synthetic))
          )
            throw new SecurityError(
              'privacy',
              'Public scanner workflow rejects private/real target data.',
            );
          readable.push(target);
        }
        const sampleVisibility = await alerts.visibility(cfg.board_repo);
        if (sampleVisibility.private === null) {
          console.warn(sampleVisibility.warning);
          includeSample = false;
        } else if (publicBoard && sampleVisibility.private) {
          throw new SecurityError(
            'privacy',
            'Public scanner workflow rejects a private mandatory sample target.',
          );
        }
      } else readable.push(...targets);
      const include = [
        ...readable.map((target, index) => ({
          ...target,
          sample: false,
          index,
          path: '.',
          synthetic:
            target.synthetic ||
            target.repo.toLowerCase() === cfg.board_repo.toLowerCase(),
          owner: target.repo.split('/')[0],
          name: target.repo.split('/')[1],
          allow_board_token:
            allowBoardToken &&
            target.repo.toLowerCase() === cfg.board_repo.toLowerCase(),
        })),
        {
          repo: cfg.board_repo,
          assessment: sampleAssessment,
          synthetic: true,
          sample: true,
          index: targets.length,
          path: samplePath,
          owner: cfg.board_repo.split('/')[0],
          name: cfg.board_repo.split('/')[1],
          allow_board_token: allowBoardToken,
        },
      ];
      if (!includeSample) include.pop();
      save({ include }, options.output);
      output({ include });
    });

  program
    .command('verify-on-merge')
    .requiredOption('--pull <number>')
    .option('--issue <number>')
    .option('--discover')
    .option('--dispatch')
    .option('--output <file>')
    .action(
      async (options: {
        pull: string;
        issue?: string;
        discover?: boolean;
        dispatch?: boolean;
        output?: string;
      }) => {
        actionsOnly();
        const pull = z.coerce.number().int().positive().parse(options.pull);
        const client = board();
        const { alerts } = clients(client);
        if (options.issue) {
          await consumeIssueIntents(client, alerts, writerIssue(options));
          const result = await verifyOnMerge(
            client,
            alerts,
            pull,
            writerIssue(options),
          );
          save(result, options.output);
          output(result);
          return;
        }
        if (!options.discover)
          throw new SecurityError('config', 'Use --discover or --issue.');
        const queued = await queueMergeIntents(client, pull);
        const issues = queued.issues;
        const dispatched = options.dispatch
          ? await dispatch(client, issues, 'merge', pull)
          : 0;
        const result = {
          pull,
          issues,
          intent_ids: queued.intent_ids,
          dispatched,
        };
        save(result, options.output);
        output(result);
      },
    );

  program
    .command('process-issue')
    .requiredOption('--issue <number>')
    .option('--mode <mode>', 'commands, sync or merge', 'commands')
    .option('--pull <number>', 'Verified same-repository merged PR', '0')
    .action(async (options: { issue: string; mode: string; pull: string }) => {
      actionsOnly();
      const number = writerIssue(options);
      const mode = z.enum(['commands', 'sync', 'merge']).parse(options.mode);
      const client = board();
      const commands = await client.applyCommands(number);
      const { alerts, enricher } = clients(client);
      const intents = await consumeIssueIntents(client, alerts, number);
      const sync = await syncSecurityIssue(client, alerts, enricher, number, {
        ...(client.config.auto_dismiss && process.env.PRONOIA_DISMISS_TOKEN
          ? {
              dismissApi: createGitHubClient(process.env.PRONOIA_DISMISS_TOKEN),
            }
          : {}),
      });
      const merge =
        mode === 'merge'
          ? await verifyOnMerge(
              client,
              alerts,
              z.coerce.number().int().positive().parse(options.pull),
              number,
            )
          : null;
      output({ issue: number, commands, intents, sync, merge });
    });

  program
    .command('queue-ai')
    .requiredOption('--issue <number>')
    .option('--mode <mode>', 'Manual collaborator-only proposal mode', 'triage')
    .option('--dispatch')
    .action(
      async (options: { issue: string; mode: string; dispatch?: boolean }) => {
        actionsOnly();
        const client = board();
        const number = writerIssue(options);
        const request = await queueManualAi(
          client,
          number,
          z
            .enum(['triage', 'remediate', 'test-plan', 'summarize'])
            .parse(options.mode),
        );
        const dispatched = options.dispatch
          ? await dispatch(client, [number], 'commands')
          : 0;
        output({ ...request, dispatched });
      },
    );

  program
    .command('ai')
    .requiredOption('--issue <number>')
    .option('--mode <mode>', 'Manual collaborator-only proposal mode', 'triage')
    .action(async (options: { issue: string; mode: string }) => {
      actionsOnly();
      const client = board();
      if (!client.integrations.foundry)
        throw new SecurityError('config', 'Foundry is not configured.');
      const number = writerIssue(options);
      await client.applyCommands(number);
      output(
        await requestManualAi(
          client,
          client.integrations.foundry,
          number,
          z
            .enum(['triage', 'remediate', 'test-plan', 'summarize'])
            .parse(options.mode),
        ),
      );
    });
}
