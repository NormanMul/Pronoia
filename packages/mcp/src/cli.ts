import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const cli = resolve(workspace, 'packages', 'cli', 'dist', 'index.js');

export function executeCli(
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted)
    return Promise.reject(new Error('Pronoia CLI request cancelled.'));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: workspace,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        // Node errors include command arguments; never echo them or child stderr.
        reject(
          new Error(
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'Pronoia CLI output exceeded the safe limit.'
              : error.killed
                ? 'Pronoia CLI timed out or was cancelled.'
                : 'Pronoia CLI execution failed. Check authentication, configuration and the CLI build.',
          ),
        );
      },
    );
  });
}
