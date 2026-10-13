import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'linux', 'This bounded process-group smoke check targets the Linux CI runner');
const base = 'http://127.0.0.1:4318';
const directory = await mkdtemp(join(tmpdir(), 'neo-smoke-'));
const controller = new AbortController();
let server;
let exited = false;
let exitCode = null;
let exitSignal = null;
let log = '';
let failed = false;
const timeout = setTimeout(() => controller.abort(new Error('Smoke check exceeded 30 seconds')), 30_000);

async function api(path, options = {}) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Only local paths are allowed');
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_500)]),
    headers: { 'Content-Type': 'application/json', 'X-Neo-Client': 'local-ui', ...options.headers },
  });
  assert.ok(response.ok, 'Unexpected HTTP ' + response.status + ' at ' + path);
  return response;
}

async function until(check, budgetMs, message) {
  const stop = Date.now() + budgetMs;
  while (Date.now() < stop) {
    controller.signal.throwIfAborted();
    if (await check()) return;
    await delay(50, undefined, { signal: controller.signal });
  }
  throw new Error(message);
}

function signalGroup(signal) {
  if (!server?.pid) return;
  try { process.kill(-server.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function groupExists() {
  if (!server?.pid) return false;
  try { process.kill(-server.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function portIsClosed() {
  return fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(500) })
    .then(() => false, () => true);
}

try {
  await access('dist/server/server/collector-worker.mjs');
  await access('dist/server/server/proxmox.mjs');
  assert.ok(await portIsClosed(), 'Port 4318 must be unused before this smoke check');
  server = spawn('npm', ['start'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEO_DB_PATH: join(directory, 'neo.sqlite') },
  });
  const record = (chunk) => { log = (log + chunk.toString()).slice(-16_000); };
  server.stdout.on('data', record);
  server.stderr.on('data', record);
  server.once('error', () => { exited = true; exitCode = 1; });
  server.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

  await until(async () => {
    if (exited) throw new Error('npm start exited before readiness');
    try {
      const response = await api('/api/v1/health');
      const health = await response.json();
      return health.status === 'ok' && health.synthetic === true && health.collector === 'fixture-only';
    } catch { return false; }
  }, 10_000, 'Compiled server never became ready');

  const page = await api('/');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /Neo THC/);
  const javascript = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const stylesheet = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  assert.ok(javascript, 'Built HTML must reference the compiled JavaScript');
  assert.ok(stylesheet, 'Built HTML must reference the compiled CSS');
  for (const [path, type] of [[javascript, 'javascript'], [stylesheet, 'text/css']]) {
    const asset = await api(path);
    assert.ok((asset.headers.get('content-type') ?? '').includes(type), 'Correct asset MIME type');
    assert.ok((await asset.text()).length > 100, 'Built asset must not be empty');
  }

  const empty = await (await api('/api/v1/assets')).json();
  assert.equal(empty.assets.length, 0, 'The smoke database must be isolated and empty');
  const created = await (await api('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      requestId: 'smoke-' + randomUUID(),
      mode: 'initial',
      scope: ['fixture:gateway', 'fixture:nas'],
      exclusions: [],
    }),
  })).json();
  let job;
  await until(async () => {
    job = (await (await api('/api/v1/jobs/' + encodeURIComponent(created.job.id))).json()).job;
    return !['queued', 'running'].includes(job.status);
  }, 10_000, 'Fixture job did not finish');
  assert.equal(job.status, 'completed');
  assert.equal(job.observationsAdded, 2);
  const inventory = await (await api('/api/v1/assets')).json();
  assert.equal(inventory.synthetic, true);
  assert.equal(inventory.assets.length, 2);
  assert.ok(inventory.assets.some((asset) => asset.kind === 'storage' && asset.health === 'unhealthy'));
  const platform = await (await api('/api/v1/jobs', {
    method: 'POST', body: JSON.stringify({ requestId: 'pve-smoke-' + randomUUID(), mode: 'initial', scope: ['fixture:proxmox-lab'] }),
  })).json();
  await until(async () => {
    job = (await (await api('/api/v1/jobs/' + encodeURIComponent(platform.job.id))).json()).job;
    return !['queued', 'running'].includes(job.status);
  }, 10_000, 'Compiled Proxmox worker did not finish');
  assert.equal(job.status, 'completed');
  assert.equal(job.observationsAdded, 5);
  const enriched = await (await api('/api/v1/assets')).json();
  assert.equal(enriched.assets.length, 7);
  assert.equal(enriched.assets.filter((asset) => asset.latest.source === 'proxmox-fixture-v1').length, 5);
  console.log('PASS: npm start, loopback health, production HTML/JS/CSS, fixture jobs and compiled Proxmox worker');
} catch (error) {
  failed = true;
  console.error('FAIL: production smoke check:', error.message);
} finally {
  clearTimeout(timeout);
  // Give cleanup its own bounded window, even if the exercise deadline expired.
  try {
    signalGroup('SIGTERM');
    const stop = Date.now() + 5_000;
    while (Date.now() < stop && (!exited || groupExists() || !(await portIsClosed()))) await delay(50);
    assert.ok(!server || (exited && !groupExists() && await portIsClosed()), 'Graceful shutdown did not finish in five seconds');
    if (server) assert.ok(exitCode === 0 || exitSignal === 'SIGTERM', 'npm start exited unexpectedly');
    if (!failed) console.log('PASS: graceful process-group shutdown and closed loopback listener');
  } catch (error) {
    failed = true;
    console.error('FAIL: smoke cleanup:', error.message);
    signalGroup('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true });
  if (failed && log) console.error('Bounded fixture-server log:\n' + log);
}
if (failed) process.exitCode = 1;
