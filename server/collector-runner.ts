import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { CollectorAdapter, CollectionContext } from './collector.js';
import { fixtureTargets, fixtureObservations } from './collector.js';
import type { ObservationInput } from '../shared/types.js';
import { PROXMOX_TARGET, PROXMOX_VERSION, parseInventory, failureCodes } from './proxmox.mjs';
import type { Resource } from './proxmox.mjs';

export const builtInTargets = [
  ...fixtureTargets,
  { key: PROXMOX_TARGET, label: 'Simulated Proxmox inventory', defaultSelected: false },
] as const;
export const fixtureScenarios = [
  'normal', 'cpu-hang', 'promise-hang', 'crash', 'early-exit', 'wrong-attempt',
  'duplicate-batch', 'late-batch', 'partial-hang', 'version-denied', 'version-malformed',
  'unsupported-version', 'guests-denied', 'guests-unavailable', 'guests-malformed', 'empty-guests',
] as const;
export type FixtureScenario = typeof fixtureScenarios[number];

/** Source, vantage, identity, timestamp and TTL are host policy, never worker claims. */
export function proxmoxObservations(resources: Resource[], installation = 'demo-lab', now = Date.now()): ObservationInput[] {
  return resources.map((resource) => ({
    id: randomUUID(),
    subjectKey: installation + '/' + resource.id,
    label: resource.label,
    kind: resource.type === 'node' ? 'proxmox-node' : resource.type === 'lxc' ? 'container' : 'virtual-machine',
    source: 'proxmox-fixture-v1',
    vantage: 'synthetic-proxmox-demo',
    observedAt: now,
    ttlMs: 60_000,
    status: resource.type !== 'node' && !resource.template && resource.platformState === 'stopped' ? 'stopped' : 'unknown',
    note: 'Synthetic Proxmox ' + PROXMOX_VERSION + ' inventory; platform state: ' + resource.platformState +
      '; node: ' + resource.node + (resource.template ? '; template' : '') +
      '. Permission-filtered coverage: completeness unknown. Collected time is Neo receipt time, not the original platform measurement time. Platform state is not service-health evidence.',
    identifiers: [{ kind: 'platform-id', value: installation + '/' + resource.id }],
    services: [],
  }));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worker message');
  return value as Record<string, unknown>;
}

/** Trusted built-in code only. Worker limits provide hang isolation, not an OS sandbox. */
export class IsolatedCollector implements CollectorAdapter {
  readonly id = 'fixture-v1';
  readonly isolated = true as const;
  readonly capabilities = ['fixture-observations'] as const;
  readonly targets = builtInTargets;
  private active: Worker | null = null;
  private disabled = false;
  private started = 0;
  private exited = 0;

  // Internal test-only construction seam. There is no API/env setting for scenarios.
  constructor(private readonly scenarios: Readonly<Record<string, FixtureScenario>> = {}) {
    if (Object.keys(scenarios).some((target) => !builtInTargets.some((item) => item.key === target)) ||
      Object.values(scenarios).some((scenario) => !fixtureScenarios.includes(scenario))) {
      throw new Error('Unregistered fixture scenario');
    }
  }

  get problem(): string | null {
    return this.disabled ? 'Collector cleanup failed. Collection is disabled; restart Neo before collecting again.' : null;
  }
  get statistics() { return { started: this.started, exited: this.exited, active: this.active ? 1 : 0 }; }

  async collect(target: string, context: CollectionContext): Promise<ObservationInput[]> {
    context.signal.throwIfAborted();
    if (this.disabled || this.active) throw new Error('Collector unavailable');
    if (!this.targets.some((item) => item.key === target)) throw new Error('Unregistered target');
    const attemptId = randomUUID();
    const worker = new Worker(new URL('./collector-worker.mjs', import.meta.url), {
      workerData: { v: 1, attemptId, target, cycle: context.cycle, scenario: this.scenarios[target] ?? 'normal' },
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    this.active = worker;
    this.started++;
    worker.stdout.resume();
    worker.stderr.resume();
    const seen = new Set<string>();
    const collected: ObservationInput[] = [];
    return new Promise((resolve, reject) => {
      let settling = false;
      let messages = 0;
      const finish = async (error: Error | null) => {
        if (settling) return;
        settling = true;
        clearTimeout(deadline);
        context.signal.removeEventListener('abort', abort);
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const terminated = await Promise.race([
            worker.terminate().then(() => true),
            new Promise<boolean>((done) => { cleanupTimer = setTimeout(() => done(false), 1_000); }),
          ]);
          if (!terminated) {
            this.disabled = true;
            worker.unref();
            error = new Error('Collector cleanup failed');
          } else if (this.active === worker) this.active = null;
        } catch {
          this.disabled = true;
          worker.unref();
          error = new Error('Collector cleanup failed');
        } finally { clearTimeout(cleanupTimer); }
        if (error) reject(error); else resolve(collected);
      };
      const abort = () => { void finish(new Error('Collection cancelled')); };
      const deadline = setTimeout(() => { void finish(new Error('Collection deadline exceeded')); }, context.timeoutMs ?? 750);
      context.signal.addEventListener('abort', abort, { once: true });
      worker.once('error', () => { void finish(new Error('Collector failed')); });
      worker.once('exit', () => {
        this.exited++;
        if (!settling) void finish(new Error('Collector exited without completion'));
      });
      worker.on('message', (raw: unknown) => {
        if (settling || context.signal.aborted) return;
        try {
          if (++messages > 4 || typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262_144) throw new Error('Invalid worker message');
          const message = record(JSON.parse(raw));
          if (message.v !== 1 || message.attemptId !== attemptId || message.target !== target) throw new Error('Invalid worker identity');
          if (message.type === 'batch') {
            if (Object.keys(message).some((key) => !['v', 'attemptId', 'target', 'type', 'operation', 'records'].includes(key))) throw new Error('Unexpected worker fields');
            const operation = message.operation;
            if (typeof operation !== 'string' || seen.has(operation)) throw new Error('Duplicate worker batch');
            let observations: ObservationInput[];
            if (target === PROXMOX_TARGET) {
              if (operation !== 'pve.nodes' && operation !== 'pve.guests') throw new Error('Unregistered operation');
              observations = proxmoxObservations(parseInventory(operation, JSON.stringify({ data: message.records })));
            } else {
              if (operation !== 'fixture' || !Array.isArray(message.records) || message.records.length !== 1 ||
                Object.keys(record(message.records[0])).length !== 1 || record(message.records[0]).target !== target) {
                throw new Error('Invalid fixture batch');
              }
              observations = fixtureObservations(target, context);
            }
            seen.add(operation);
            context.signal.throwIfAborted();
            if (context.onBatch) context.onBatch(observations); else collected.push(...observations);
          } else if (message.type === 'done') {
            if (Object.keys(message).some((key) => !['v', 'attemptId', 'target', 'type', 'failures'].includes(key)) ||
              !Array.isArray(message.failures) || message.failures.length > 2 ||
              message.failures.some((code) => typeof code !== 'string' || !failureCodes.includes(code))) throw new Error('Invalid completion');
            const expected = target === PROXMOX_TARGET ? ['pve.nodes', 'pve.guests'] : ['fixture'];
            if (message.failures.length || expected.some((operation) => !seen.has(operation))) {
              void finish(new Error('Collection failed; useful partial evidence was retained'));
            } else void finish(null);
          } else throw new Error('Invalid worker message');
        } catch { void finish(new Error('Invalid collector result; useful partial evidence was retained')); }
      });
      if (context.signal.aborted) abort();
    });
  }
}
