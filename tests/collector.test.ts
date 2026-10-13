import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { IsolatedCollector, proxmoxObservations, type FixtureScenario } from '../server/collector-runner.js';
import { mockTransport, parseVersion, parseInventory, runProxmox, PVE_OPERATIONS, PROXMOX_TARGET } from '../server/proxmox.mjs';
import { FixtureCollector, type CollectorAdapter } from '../server/collector.js';
import { Store } from '../server/store.js';
import type { Job, ObservationInput } from '../shared/types.js';

const headers = { host: '127.0.0.1:4318', 'x-neo-client': 'local-ui' };
const raw = (data: unknown) => JSON.stringify({ data });
const guest = { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'demo-a', name: 'Demo guest', status: 'running' };
const context = (extra = {}) => ({ signal: new AbortController().signal, now: Date.now(), cycle: 0, timeoutMs: 1_000, ...extra });
async function terminal(store: Store, id: string): Promise<Job> {
  const stop = Date.now() + 5_000;
  while (Date.now() < stop) {
    const job = store.job(id)!;
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(10);
  }
  throw new Error('Collector job did not terminate');
}

test('mock Proxmox uses only the fixed version/nodes/guests GET plan', async () => {
  const transport = mockTransport();
  const batches: unknown[] = [];
  assert.deepEqual(await runProxmox(transport.request, (operation, resources) => batches.push({ operation, resources })), []);
  assert.deepEqual(transport.calls, ['pve.version', 'pve.nodes', 'pve.guests']);
  assert.deepEqual(Object.values(PVE_OPERATIONS).map((operation) => operation.method), ['GET', 'GET', 'GET']);
  assert.deepEqual(Object.values(PVE_OPERATIONS).map((operation) => operation.path),
    ['/api2/json/version', '/api2/json/cluster/resources?type=node', '/api2/json/cluster/resources?type=vm']);
  assert.equal(batches.length, 2);
  await assert.rejects(transport.request('pve.configure'));
});

test('version denial, mismatch and unsupported profile stop before inventory', async () => {
  for (const scenario of ['version-denied', 'version-malformed', 'unsupported-version']) {
    const transport = mockTransport(scenario);
    let batches = 0;
    const failures = await runProxmox(transport.request, () => batches++);
    assert.equal(failures.length, 1);
    assert.deepEqual(transport.calls, ['pve.version']);
    assert.equal(batches, 0);
    assert.ok(!JSON.stringify(failures).includes('PRIVATE'));
  }
  assert.throws(() => parseVersion(raw({ version: '8.4.22', release: '8.4' })));
  assert.throws(() => parseVersion(raw({ version: '8.4.23', release: '8.4', repoid: '01234567' })));
});

test('inventory schemas bound payloads and preserve identity consistency', () => {
  for (const data of [null, {}, [{ ...guest, vmid: -1 }], [{ ...guest, vmid: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...guest, id: 'qemu/101' }], [{ ...guest, type: 'storage' }], [{ ...guest, node: '../other' }],
    [{ ...guest, name: 'x'.repeat(201) }], [{ ...guest, template: 2 }],
    [guest, { ...guest, status: 'stopped' }], Array.from({ length: 101 }, () => guest)]) {
    assert.throws(() => parseInventory('pve.guests', raw(data)));
  }
  assert.throws(() => parseInventory('pve.guests', 'x'.repeat(262_145)));
  assert.throws(() => parseInventory('pve.nodes', raw([{ id: 'node/wrong', type: 'node', node: 'demo-a' }])));
  const safe = parseInventory('pve.guests', raw([{ ...guest, privateSecret: 'DROP ME' }, guest]));
  assert.equal(safe.length, 1);
  assert.ok(!JSON.stringify(safe).includes('DROP ME'));
  assert.equal(parseInventory('pve.guests', raw([{ ...guest, name: '' }]))[0].label, 'QEMU 100');
});

test('migration keeps installation-scoped identity and platform state is not health', () => {
  const store = new Store();
  try {
    const first = proxmoxObservations(parseInventory('pve.guests', raw([guest])), 'demo-lab', 10_000);
    store.ingest(first);
    const id = store.assets(10_000)[0].id;
    assert.equal(first[0].status, 'unknown');
    store.ingest(proxmoxObservations(parseInventory('pve.guests', raw([{ ...guest, node: 'demo-b' }])), 'demo-lab', 10_001));
    assert.equal(store.assets(10_001)[0].id, id);
    store.ingest(proxmoxObservations(parseInventory('pve.guests', raw([guest])), 'another-demo-lab', 10_001));
    assert.equal(store.assets(10_001).length, 2);
    const stopped = parseInventory('pve.guests', raw([{ ...guest, status: 'stopped' }]));
    assert.equal(proxmoxObservations(stopped)[0].status, 'stopped');
    assert.equal(proxmoxObservations(parseInventory('pve.guests', raw([{ ...guest, status: 'stopped', template: 1 }])))[0].status, 'unknown');
    const node = parseInventory('pve.nodes', raw([{ id: 'node/demo-a', type: 'node', node: 'demo-a', status: 'offline' }]));
    assert.equal(proxmoxObservations(node)[0].status, 'unknown');
    assert.ok(store.assets(80_002).every((asset) => asset.freshness === 'stale' && asset.health === 'unknown'));
    assert.equal(store.observations(id).length, 2);
    assert.ok(first[0].identifiers.every((identifier) => identifier.kind === 'platform-id'));
  } finally { store.close(); }
});

test('permission-filtered empty and denied guest responses preserve earlier guests', async () => {
  const store = new Store();
  try {
    const normal = mockTransport();
    await runProxmox(normal.request, (_operation, resources) => store.ingest(proxmoxObservations(resources)));
    const prior = store.assets().find((asset) => asset.label === 'Demo application VM')!;
    const before = store.observations(prior.id)[0].id;
    for (const scenario of ['empty-guests', 'guests-denied', 'guests-unavailable', 'guests-malformed']) {
      const transport = mockTransport(scenario);
      const failures = await runProxmox(transport.request, (_operation, resources) => store.ingest(proxmoxObservations(resources)));
      assert.equal(failures.length, scenario === 'empty-guests' ? 0 : 1);
      assert.equal(store.assets().length, 5);
      assert.equal(store.observations(prior.id)[0].id, before);
      assert.match(store.assets()[0].latest!.note, /completeness unknown/);
    }
  } finally { store.close(); }
});

test('real worker runs in source mode without inherited preloads or environment', async () => {
  const previous = process.env.NEO_TEST_SENTINEL;
  process.env.NEO_TEST_SENTINEL = 'synthetic-sentinel';
  const collector = new IsolatedCollector();
  try {
    const observations = await collector.collect(PROXMOX_TARGET, context());
    assert.equal(observations.length, 5);
    assert.ok(observations.every((item) => item.source === 'proxmox-fixture-v1' && item.vantage === 'synthetic-proxmox-demo'));
    assert.ok(observations.every((item) => !JSON.stringify(item).includes('synthetic-sentinel')));
    assert.deepEqual(collector.statistics, { started: 1, exited: 1, active: 0 });
  } finally {
    if (previous === undefined) delete process.env.NEO_TEST_SENTINEL;
    else process.env.NEO_TEST_SENTINEL = previous;
  }
});

test('CPU-hung worker cannot block health or later targets and its slot is reaped', async () => {
  const collector = new IsolatedCollector({ 'fixture:gateway': 'cpu-hang' });
  const { app, store } = createApp({ adapter: collector, probeTimeoutMs: 250 });
  try {
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'worker-cpu-test', mode: 'initial', scope: ['fixture:gateway', 'fixture:nas'] } });
    const id = submitted.json().job.id;
    await delay(60);
    assert.equal((await app.inject({ url: '/api/v1/health', headers })).statusCode, 200);
    assert.equal(store.job(id)!.status, 'running');
    const job = await terminal(store, id);
    assert.equal(job.status, 'failed');
    assert.equal(job.completedTargets, 2);
    assert.equal(job.observationsAdded, 1);
    assert.deepEqual(collector.statistics, { started: 2, exited: 2, active: 0 });
    assert.equal(store.assets()[0].label, 'Demo storage');
  } finally { await app.close(); }
});

test('promise hang, crash, early exit and forged attempt cannot leak diagnostics or evidence', async () => {
  for (const scenario of ['promise-hang', 'crash', 'early-exit', 'wrong-attempt'] as FixtureScenario[]) {
    const collector = new IsolatedCollector({ [PROXMOX_TARGET]: scenario });
    const received: ObservationInput[] = [];
    await assert.rejects(collector.collect(PROXMOX_TARGET, context({
      timeoutMs: 250, onBatch: (items: ObservationInput[]) => received.push(...items),
    })), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE'));
    assert.equal(received.length, 0);
    assert.equal(collector.statistics.active, 0);
    assert.equal(collector.statistics.exited, 1);
  }
});

test('partial node batches survive a guest CPU hang and the job reports failure', async () => {
  const collector = new IsolatedCollector({ [PROXMOX_TARGET]: 'partial-hang' });
  const { app, store } = createApp({ adapter: collector, probeTimeoutMs: 250 });
  try {
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'worker-partial-test', mode: 'initial', scope: [PROXMOX_TARGET] } });
    const job = await terminal(store, submitted.json().job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.observationsAdded, 2);
    assert.equal(store.assets().length, 2);
    assert.ok(store.assets().every((asset) => asset.health === 'unknown'));
    assert.match(job.errors[0], /partial results/);
    assert.equal(collector.statistics.active, 0);
  } finally { await app.close(); }
});

test('cancellation before startup and after first batch allows no later writes', async () => {
  const collector = new IsolatedCollector();
  const early = new AbortController();
  early.abort();
  await assert.rejects(collector.collect(PROXMOX_TARGET, context({ signal: early.signal })));
  assert.equal(collector.statistics.started, 0);
  const controller = new AbortController();
  const received: ObservationInput[] = [];
  await assert.rejects(collector.collect(PROXMOX_TARGET, context({
    signal: controller.signal,
    onBatch: (items: ObservationInput[]) => { received.push(...items); controller.abort(); controller.abort(); },
  })));
  assert.equal(received.length, 2);
  await delay(50);
  assert.equal(received.length, 2);
  assert.equal(collector.statistics.active, 0);
  assert.equal((await collector.collect('fixture:nas', context())).length, 1);
});

test('duplicate batch fails without double counting and post-done messages are ignored', async () => {
  const duplicate = new IsolatedCollector({ [PROXMOX_TARGET]: 'duplicate-batch' });
  const received: ObservationInput[] = [];
  await assert.rejects(duplicate.collect(PROXMOX_TARGET, context({ onBatch: (items: ObservationInput[]) => received.push(...items) })));
  assert.equal(received.length, 2);
  const late = new IsolatedCollector({ [PROXMOX_TARGET]: 'late-batch' });
  const accepted: ObservationInput[] = [];
  await late.collect(PROXMOX_TARGET, context({ onBatch: (items: ObservationInput[]) => accepted.push(...items) }));
  assert.equal(accepted.length, 5);
  assert.ok(accepted.every((item) => !item.subjectKey.includes('late-node')));
  const before = JSON.stringify(accepted);
  assert.equal((await late.collect('fixture:nas', context())).length, 1);
  await delay(50);
  assert.equal(JSON.stringify(accepted), before);
  assert.equal(late.statistics.active, 0);
});

test('whole-job deadline and shutdown terminate real workers', async () => {
  const collector = new IsolatedCollector({ 'fixture:gateway': 'cpu-hang' });
  const { app, store, jobs } = createApp({ adapter: collector, probeTimeoutMs: 5_000 });
  try {
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'worker-total-deadline', mode: 'initial', scope: ['fixture:gateway'], maxDurationMs: 1_000 } });
    assert.equal((await terminal(store, submitted.json().job.id)).status, 'timed_out');
    assert.equal(collector.statistics.active, 0);
    const next = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'worker-shutdown-test', mode: 'initial', scope: ['fixture:gateway'] } });
    await delay(20);
    await jobs.shutdown();
    assert.equal(store.job(next.json().job.id)!.status, 'interrupted');
    assert.equal(collector.statistics.active, 0);
  } finally { await app.close(); }
});

test('excluded mock integration launches no worker and arbitrary operation fields are rejected', async () => {
  const collector = new IsolatedCollector();
  const { app, store } = createApp({ adapter: collector });
  try {
    const payload = { requestId: 'worker-exclusion-test', mode: 'initial',
      scope: [PROXMOX_TARGET, 'fixture:gateway'], exclusions: [PROXMOX_TARGET] };
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload });
    assert.equal((await terminal(store, submitted.json().job.id)).observationsAdded, 1);
    assert.equal(collector.statistics.started, 1);
    for (const field of ['url', 'method', 'operation', 'headers', 'module', 'credentials', 'scenario']) {
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: { ...payload, [field]: 'not-allowed' } });
      assert.equal(invalid.statusCode, 400);
    }
  } finally { await app.close(); }
});

test('timed-out fallback batches cannot modify finished jobs or a newer job', async () => {
  const fixture = new FixtureCollector();
  const late: { callback?: (items: ObservationInput[]) => void } = {};
  const adapter: CollectorAdapter = {
    id: fixture.id, capabilities: fixture.capabilities, targets: fixture.targets,
    collect(target, context) {
      if (target === 'fixture:gateway') {
        late.callback = context.onBatch;
        return new Promise(() => {});
      }
      return fixture.collect(target, context);
    },
  };
  const { app, store } = createApp({ adapter, probeTimeoutMs: 20 });
  try {
    const first = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'fallback-late-first', mode: 'initial', scope: ['fixture:gateway', 'fixture:nas'] } });
    const firstId = first.json().job.id;
    assert.equal((await terminal(store, firstId)).status, 'failed');
    const second = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { requestId: 'fallback-late-second', mode: 'initial', scope: ['fixture:nas'] } });
    const secondId = second.json().job.id;
    assert.equal((await terminal(store, secondId)).status, 'completed');
    const before = JSON.stringify({ jobs: store.jobs(), assets: store.assets() });
    assert.equal(typeof late.callback, 'function');
    late.callback!(await fixture.collect('fixture:gateway', context()));
    await delay(30);
    assert.equal(JSON.stringify({ jobs: store.jobs(), assets: store.assets() }), before);
    assert.equal(store.assets().length, 1);
    assert.equal(store.job(firstId)!.observationsAdded, 1);
    assert.equal(store.job(secondId)!.observationsAdded, 1);
  } finally { await app.close(); }
});
