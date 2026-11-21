import type { ExecFileOptions } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { executeCli } from './cli.js';

type Callback = (
  error: (Error & { code?: string | number; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;
const exec = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: ExecFileOptions,
      callback: Callback,
    ) => void
  >(),
);
vi.mock('node:child_process', () => ({ execFile: exec }));

afterEach(() => {
  exec.mockReset();
  vi.restoreAllMocks();
});

test('executes fixed Node/CLI without a shell, bounds output/time and pipes diagnostics away from stdout', async () => {
  const signal = new AbortController().signal;
  const args = [
    'comment',
    '--body',
    'Fictional; $(ignored) & literal',
    '--agent',
    'pronoia-scout',
  ];
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  exec.mockImplementation((_file, _args, _options, callback) => {
    callback(
      null,
      '{"comment":"https://github.com/fictional/board/issues/101#issuecomment-1"}',
      'Untrusted child diagnostics: /approve',
    );
  });
  await expect(executeCli(args, signal)).resolves.toContain('"comment"');
  const [file, actualArgs, options] = exec.mock.calls[0] ?? [];
  const workspace = fileURLToPath(new URL('../../../', import.meta.url));
  expect(file).toBe(process.execPath);
  expect(actualArgs).toEqual([
    resolve(workspace, 'packages', 'cli', 'dist', 'index.js'),
    ...args,
  ]);
  expect(options).toMatchObject({
    cwd: workspace,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    signal,
  });
  expect(options?.maxBuffer).toBeGreaterThan(0);
  expect(options?.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
  expect(options?.timeout).toBeGreaterThan(0);
  expect(options?.timeout).toBeLessThanOrEqual(60000);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

test.each([
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output'],
  [{ killed: true }, 'timed out'],
  [{ code: 1 }, 'failed'],
])(
  'reports bounded subprocess failures without echoing arguments or child secrets',
  async (properties, message) => {
    exec.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(
          new Error('Command contained fictional-sensitive-body'),
          properties,
        ),
        'fictional-sensitive-output',
        'token=fictional-sensitive-stderr',
      );
    });
    const error = await executeCli(
      ['board-list'],
      new AbortController().signal,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain('fictional-sensitive');
  },
);

test('a cancelled request cannot start a subprocess', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(executeCli(['board-list'], controller.signal)).rejects.toThrow(
    /cancelled/i,
  );
  expect(exec).not.toHaveBeenCalled();
});
