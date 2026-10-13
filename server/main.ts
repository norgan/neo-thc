import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

// This demo has no LAN bind option and must not be placed behind a public proxy.
const path = resolve(process.env.NEO_DB_PATH ?? 'data/neo.sqlite');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const webRoot = resolve('dist/web');
const { app } = createApp({ dbPath: path, webRoot: existsSync(webRoot) ? webRoot : undefined });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  await app.listen({ host: '127.0.0.1', port: 4318 });
  console.log('Neo THC: http://127.0.0.1:4318. Fixtures are separate; network discovery requires explicit scope and Start.');
} catch {
  console.error('Neo could not start. Check Node 24, database permissions, and whether port 4318 is already in use.');
  await app.close();
  process.exitCode = 1;
}
