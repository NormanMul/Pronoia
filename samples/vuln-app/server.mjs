import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

assert(
  process.permission?.has('fs.read', import.meta.dirname) &&
    !process.permission.has('fs.read', homedir()),
  'Use the restricted npm start script in a disposable synthetic-only environment.',
);

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE checks (id INTEGER PRIMARY KEY, name TEXT, owner TEXT);
  INSERT INTO checks VALUES
    (1, 'MFA demonstration', 'Contoso'),
    (2, 'Firewall demonstration', 'Fabrikam'),
    (3, 'Migration demonstration', 'Northwind');
`);
const app = express();
app.disable('x-powered-by');

app.get('/search', (request, response) => {
  try {
    // Intentionally injectable: only the in-memory synthetic table is present.
    const rows = database
      .prepare(
        `SELECT id, name, owner FROM checks WHERE name LIKE '%${String(request.query.q ?? '')}%'`,
      )
      .all();
    response.json({ synthetic: true, rows });
  } catch {
    response.status(400).json({ error: 'Synthetic query failed.' });
  }
});

app.get('/files', (request, response) => {
  try {
    // Intentionally traversable; Node's permission boundary limits reads to this sample.
    const file = join(
      import.meta.dirname,
      'data',
      String(request.query.name ?? 'demo.txt'),
    );
    response.type('text/plain').send(readFileSync(file, 'utf8'));
  } catch {
    response
      .status(400)
      .json({ error: 'Synthetic file read denied or failed.' });
  }
});

app.listen(3033, '127.0.0.1', () => {
  console.log(
    'Synthetic-only vulnerable demo on loopback port 3033. Never deploy.',
  );
});
