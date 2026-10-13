import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'http://127.0.0.1:4318';

export const test = base.extend<{ localApp: void }>({
  localApp: [async ({ page }, use, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-browser-'));
    let output = '';
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let server: ReturnType<typeof spawn> | undefined;
    let forced = false;
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        external.push(url.origin);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    try {
      const occupied = await fetch(origin + '/api/v1/health', { signal: AbortSignal.timeout(500) })
        .then(() => true, () => false);
      expect(occupied, 'Each browser case requires its own loopback server').toBe(false);
      server = spawn(process.execPath, ['dist/server/server/main.js'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEO_DB_PATH: join(directory, 'neo.sqlite') },
      });
      const record = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
      server.stdout?.on('data', record);
      server.stderr?.on('data', record);
      server.once('error', () => { exited = true; exitCode = 1; });
      server.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        if (exited) throw new Error('Isolated browser server exited before readiness');
        ready = await fetch(origin + '/api/v1/health', { signal: AbortSignal.timeout(500) })
          .then(async (response) => response.ok && (await response.json()).runtime === 'real-discovery-v2', () => false);
        if (!ready) await delay(50);
      }
      expect(ready, 'Isolated production server should become ready').toBe(true);
      await use();
      expect(errors, 'No uncaught browser errors').toEqual([]);
      expect(external, 'The fixture UI must not send external requests').toEqual([]);
    } finally {
      if (server && !exited) server.kill('SIGTERM');
      const deadline = Date.now() + 5_000;
      while (server && !exited && Date.now() < deadline) await delay(25);
      if (server && !exited) {
        forced = true;
        server.kill('SIGKILL');
        const killDeadline = Date.now() + 1_000;
        while (!exited && Date.now() < killDeadline) await delay(25);
      }
      if (testInfo.status !== testInfo.expectedStatus || forced || exitCode !== 0) {
        await testInfo.attach('bounded-fixture-server-log', { body: output, contentType: 'text/plain' });
      }
      await rm(directory, { recursive: true, force: true });
      expect(forced, 'Production server must shut down gracefully').toBe(false);
      if (server) {
        expect(exited).toBe(true);
        expect(exitCode === 0 || exitSignal === 'SIGTERM').toBe(true);
      }
    }
  }, { auto: true }],
});

export { expect };
