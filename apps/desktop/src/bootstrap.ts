import { app, dialog } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

app.setName('Pronoia');
if (process.env.PRONOIA_USER_DATA_DIR) {
  const directory = z
    .string()
    .refine(
      (value) => path.isAbsolute(value) && existsSync(value),
      'Choose an existing absolute private data folder.',
    )
    .parse(process.env.PRONOIA_USER_DATA_DIR);
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
}

// Initialize private paths synchronously before the asynchronous SDK module loads.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  void import(pathToFileURL(path.join(__dirname, 'main.mjs')).href).catch(
    (error: unknown) => {
      console.error(
        'Pronoia startup failed:',
        error instanceof Error ? error.name : 'UnknownError',
      );
      if (error instanceof Error) {
        console.error(
          error.message.replace(
            /\bgh[pousr]_[A-Za-z0-9]{20,}\b|Bearer\s+\S+|\b(?:api[_-]?key|password|secret)\s*[:=]\s*\S+/gi,
            '[credential redacted]',
          ),
        );
      }
      dialog.showErrorBox(
        'Pronoia could not start',
        'The packaged application failed to load. Check the installed package and private data folder.',
      );
      app.quit();
    },
  );
}
