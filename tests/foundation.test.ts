import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { FixtureCollector, type CollectorAdapter } from '../server/collector.js';
import { JobManager, parseSubmission, RequestError } from '../server/jobs.js';
import { Store } from '../server/store.js';
import type { Job, ObservationInput } from '../shared/types.js';

const headers = { host: '127.0.0.1:4318', 'x-neo-client': 'local-ui' };
const targets = ['fixture:gateway', 'fixture:nas', 'fixture:vm', 'fixture:unknown', 'fixture:old-lease', 'fixture:new-lease'];
function submission(overrides: Record<string, unknown> = {}) {
  return { requestId: 'test-request-0001', mode: 'initial', scope: targets, exclusions: [], ...overrides };
}
async function terminal(store: Store, id: string, timeout = 3_000): Promise<Job> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = store.job(id);
    if (job && job.status !== 'queued' && job.status !== 'running') return job;
    await delay(5);
  }
  throw new Error('Test job did not terminate');
}
function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    id: 'event-1', subjectKey: 'fixture:gateway', label: 'Demo gateway', kind: 'device',
    source: 'fixture-v1', vantage: 'synthetic-local-demo', observedAt: 10_000, ttlMs: 1_000,
    status: 'healthy', note: 'Synthetic evidence', identifiers: [{ kind: 'ip', value: '192.0.2.1' }],
    services: [], ...overrides,
  };
}

test('identity never merges on address, duplicate events are idempotent, and conflicts persist', () => {
  const store = new Store();
  try {
    const first = observation();
    assert.equal(store.ingest([first, first], 10_000), 1);
    store.ingest([observation({ id: 'event-2', subjectKey: 'fixture:other', label: 'Other demo device' })], 10_000);
    const assets = store.assets(10_000);
    assert.equal(assets.length, 2);
    assert.notEqual(assets[0].id, assets[1].id);
    assert.ok(assets.every((asset) => asset.identityWarnings.length > 0));
    const originalId = assets.find((asset) => asset.label === 'Demo gateway')!.id;
    store.ingest([observation({ id: 'event-3', observedAt: 10_001, identifiers: [{ kind: 'ip', value: '192.0.2.2' }] })], 10_001);
    assert.equal(store.assets(10_001).find((asset) => asset.label === 'Demo gateway')!.id, originalId);
    assert.equal(store.observations(originalId).length, 2);
    assert.equal(store.observations(originalId)[1].identifiers[0].value, '192.0.2.1');
  } finally { store.close(); }
});

test('stale evidence preserves its observed result but reports current health as unknown', () => {
  const store = new Store();
  try {
    store.ingest([
      observation({ status: 'unhealthy' }),
      observation({ id: 'stopped', subjectKey: 'stopped', status: 'stopped' }),
      observation({ id: 'unknown', subjectKey: 'unknown', status: 'unknown' }),
    ]);
    const fresh = store.assets(10_000);
    assert.ok(fresh.some((asset) => asset.health === 'unhealthy'));
    assert.ok(fresh.some((asset) => asset.health === 'stopped'));
    assert.ok(fresh.some((asset) => asset.health === 'unknown'));
    const stale = store.assets(11_001);
    assert.ok(stale.every((asset) => asset.freshness === 'stale' && asset.health === 'unknown'));
    assert.ok(stale.some((asset) => asset.latest?.status === 'unhealthy'));
  } finally { store.close(); }
});

test('strict scope and bounds reject real targets and malformed submissions', () => {
  assert.throws(() => parseSubmission(submission({ scope: ['192.168.1.0/24'] }), targets));
  assert.throws(() => parseSubmission(submission({ scope: [targets[0], targets[0]] }), targets));
  assert.throws(() => parseSubmission(submission({ exclusions: targets }), targets));
  assert.throws(() => parseSubmission(submission({ maxDurationMs: 60_001 }), targets));
  assert.throws(() => parseSubmission(submission({ intervalMs: 10 }), targets));
  assert.throws(() => parseSubmission(submission({ maxCycles: 2 }), targets));
  assert.throws(() => parseSubmission(submission({ token: 'not-a-real-secret' }), targets));
  assert.throws(() => parseSubmission(submission({ requestId: 'short' }), targets));
});

test('API handles empty state, initial fixtures, evidence, exclusions, and idempotency', async () => {
  const { app, store } = createApp();
  try {
    const empty = await app.inject({ url: '/api/v1/assets', headers });
    assert.deepEqual(empty.json().assets, []);
    const payload = submission({ exclusions: ['fixture:gateway'] });
    const start = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload });
    assert.equal(start.statusCode, 202);
    const job = await terminal(store, start.json().job.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.observationsAdded, 5);
    assert.equal(job.completedTargets, 5);
    const again = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().job.id, job.id);
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: submission() });
    assert.equal(conflict.statusCode, 409);
    const snapshot = await app.inject({ url: '/api/v1/snapshot', headers });
    const assets = snapshot.json().assets as ReturnType<Store['assets']>;
    assert.equal(assets.length, 5);
    assert.ok(assets.every((asset) => asset.label !== 'Demo gateway'));
    const nas = assets.find((asset) => asset.kind === 'storage')!;
    assert.equal(nas.health, 'unhealthy');
    assert.deepEqual(nas.latest!.services.map((service) => service.status), ['healthy', 'healthy', 'unhealthy']);
    const evidence = await app.inject({ url: '/api/v1/assets/' + nas.id, headers });
    assert.equal(evidence.json().observations.length, 1);
    assert.equal(evidence.json().observations[0].source, 'fixture-v1');
    assert.equal((await app.inject({ url: '/api/v1/assets/missing', headers })).statusCode, 404);
  } finally { await app.close(); }
});

test('host, origin and local-client guards reject untrusted browser requests', async () => {
  const { app } = createApp();
  try {
    assert.equal((await app.inject({ url: '/api/v1/snapshot', headers: { host: 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/snapshot', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { host: headers.host }, payload: submission() })).statusCode, 403);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: submission({ scope: ['10.0.0.1'] }) });
    assert.equal(bad.statusCode, 400);
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: 'Invalid request' });
  } finally { await app.close(); }
});

test('live fixture collection repeats then completes at the cycle bound', async () => {
  const { app, store } = createApp();
  try {
    const start = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: submission({ mode: 'live', scope: ['fixture:gateway'], intervalMs: 1_000, maxCycles: 2 }) });
    const job = await terminal(store, start.json().job.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.cyclesCompleted, 2);
    assert.equal(job.observationsAdded, 2);
    assert.equal(store.assets().length, 1);
  } finally { await app.close(); }
});

test('one active job, cancellation, and repeated cancellation preserve partial results', async () => {
  const { app, store } = createApp();
  try {
    const payload = submission({ mode: 'live', maxCycles: 10, intervalMs: 1_000 });
    const start = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload });
    const id = start.json().job.id as string;
    const second = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: { ...payload, requestId: 'second-request-0001' } });
    assert.equal(second.statusCode, 409);
    const firstCycleDeadline = Date.now() + 1_000;
    while (store.job(id)!.cyclesCompleted === 0 && Date.now() < firstCycleDeadline) await delay(5);
    assert.equal(store.job(id)!.cyclesCompleted, 1);
    const cancel = await app.inject({ method: 'POST', url: '/api/v1/jobs/' + id + '/cancel', headers, payload: {} });
    assert.equal(cancel.statusCode, 202);
    const job = await terminal(store, id);
    assert.equal(job.status, 'cancelled');
    assert.ok(job.observationsAdded > 0);
    assert.equal(store.assets().length, 6);
    const again = await app.inject({ method: 'POST', url: '/api/v1/jobs/' + id + '/cancel', headers, payload: {} });
    assert.equal(again.json().job.status, 'cancelled');
  } finally { await app.close(); }
});

test('whole-job deadline stops live collection without discarding the first cycle', async () => {
  const { app, store } = createApp();
  try {
    const start = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers,
      payload: submission({ mode: 'live', maxCycles: 10, intervalMs: 2_000, maxDurationMs: 1_000 }) });
    const job = await terminal(store, start.json().job.id);
    assert.equal(job.status, 'timed_out');
    assert.equal(job.cyclesCompleted, 1);
    assert.equal(job.observationsAdded, 6);
  } finally { await app.close(); }
});

test('an unresolved async probe is bounded, redacted, and does not block later targets', async () => {
  const fixture = new FixtureCollector();
  const adapter: CollectorAdapter = {
    id: fixture.id, capabilities: fixture.capabilities, targets: fixture.targets,
    collect: (target, context) => target === 'fixture:gateway'
      ? new Promise<ObservationInput[]>(() => {}) : fixture.collect(target, context),
  };
  const { app, store } = createApp({ adapter, probeTimeoutMs: 10 });
  try {
    const start = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: submission() });
    const job = await terminal(store, start.json().job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.completedTargets, 6);
    assert.equal(job.observationsAdded, 5);
    assert.equal(job.errors.length, 1);
    assert.match(job.errors[0], /failed or timed out/);
  } finally { await app.close(); }
});

test('shutdown interrupts and waits for active collection before the store closes', async () => {
  const store = new Store();
  const manager = new JobManager(store, new FixtureCollector());
  try {
    const parsed = parseSubmission(submission({ mode: 'live', maxCycles: 10 }), targets);
    const job = manager.start(parsed.requestId, parsed.spec);
    await manager.shutdown();
    assert.equal(store.job(job.id)!.status, 'interrupted');
    assert.throws(() => manager.start('request-after-close', parsed.spec));
  } finally { store.close(); }
});

test('database reopening retains identity and recovers unfinished jobs as interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neo-test-'));
  let store: Store | null = new Store(join(dir, 'test.sqlite'));
  try {
    store.ingest([observation()]);
    const id = store.assets()[0].id;
    const { spec } = parseSubmission(submission(), targets);
    store.saveJob({
      id: 'persisted-job', requestId: 'persisted-request', spec, status: 'running',
      createdAt: 1, startedAt: 2, finishedAt: null, completedTargets: 1, totalTargets: 6,
      cyclesCompleted: 0, observationsAdded: 1, errors: [],
    });
    store.close();
    store = new Store(join(dir, 'test.sqlite'));
    const manager = new JobManager(store, new FixtureCollector());
    assert.equal(store.assets()[0].id, id);
    assert.equal(store.job('persisted-job')!.status, 'interrupted');
    assert.equal(store.job('persisted-job')!.observationsAdded, 1);
    await manager.shutdown();
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown thrown values and adapter-style diagnostics are sanitized', async () => {
  const { app } = createApp();
  app.get('/api/v1/test-unknown', async () => { throw 'synthetic private diagnostic'; });
  app.get('/api/v1/test-error', async () => { throw new Error('synthetic private diagnostic'); });
  app.get('/api/v1/test-bad-status', async () => { throw { statusCode: '401', detail: 'synthetic private diagnostic' }; });
  try {
    for (const url of ['/api/v1/test-unknown', '/api/v1/test-error', '/api/v1/test-bad-status']) {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'Request failed. No diagnostic details are exposed.' });
      assert.ok(!response.body.includes('synthetic private diagnostic'));
    }
  } finally { await app.close(); }
});

test('background persistence failures are consumed and collection fails closed', async () => {
  class FailingStore extends Store {
    private writes = 0;
    override saveJob(job: Job): void {
      this.writes++;
      if (this.writes >= 2) throw new Error('Synthetic SQLite write failure');
      super.saveJob(job);
    }
  }
  const store = new FailingStore();
  const manager = new JobManager(store, new FixtureCollector());
  try {
    const parsed = parseSubmission(submission(), targets);
    const job = manager.start(parsed.requestId, parsed.spec);
    await delay(10);
    assert.match(manager.problem ?? '', /could not be saved/);
    assert.equal(store.job(job.id)!.status, 'queued', 'Do not claim a terminal state was persisted');
    assert.throws(() => manager.start('request-after-failure', parsed.spec),
      (error: unknown) => error instanceof RequestError && error.statusCode === 503 && /could not be saved/.test(error.message));
    await manager.shutdown();
  } finally { store.close(); }
});
