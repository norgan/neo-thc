import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectionIssues, observationAllowed, type CollectorAdapter, type CollectionContext } from './collector.js';
import type { Job, JobSpec, JobStatus, ObservationInput, DiscoveryProgress, DiscoveryOutcome } from '../shared/types.js';
import { MAX_JOBS, Store } from './store.js';

export class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

export function parseSubmission(body: unknown, allowed: readonly string[]): { requestId: string; spec: JobSpec } {
  const value = object(body);
  const keys = ['requestId', 'mode', 'scope', 'exclusions', 'intervalMs', 'maxCycles', 'maxDurationMs'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new RequestError(400, 'Unknown submission field');
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.requestId)) {
    throw new RequestError(400, 'requestId must contain 8–80 letters, digits or hyphens');
  }
  if (value.mode !== 'initial' && value.mode !== 'live') throw new RequestError(400, 'Choose initial or live mode');
  function targets(input: unknown, required: boolean): string[] {
    if (!Array.isArray(input) || input.length > allowed.length || (required && input.length === 0) ||
      input.some((item) => typeof item !== 'string' || !allowed.includes(item)) ||
      new Set(input).size !== input.length) throw new RequestError(400, 'Choose unique fixture targets only');
    return [...input as string[]].sort();
  }
  function integer(input: unknown, fallback: number, min: number, max: number): number {
    const actual = input ?? fallback;
    if (typeof actual !== 'number' || !Number.isInteger(actual) || actual < min || actual > max) {
      throw new RequestError(400, 'Job limits are outside the supported bounds');
    }
    return actual;
  }
  const scope = targets(value.scope, true);
  const exclusions = targets(value.exclusions ?? [], false);
  if (exclusions.some((key) => !scope.includes(key))) throw new RequestError(400, 'Exclusions must belong to the selected scope');
  if (scope.every((key) => exclusions.includes(key))) throw new RequestError(400, 'At least one target must remain');
  const spec: JobSpec = {
    mode: value.mode,
    scope,
    exclusions,
    intervalMs: integer(value.intervalMs, 2_000, 1_000, 30_000),
    maxCycles: integer(value.maxCycles, value.mode === 'initial' ? 1 : 5, 1, 60),
    maxDurationMs: integer(value.maxDurationMs, 30_000, 1_000, 60_000),
  };
  if (spec.mode === 'initial' && spec.maxCycles !== 1) throw new RequestError(400, 'Initial mode performs exactly one cycle');
  return { requestId: value.requestId, spec };
}

/** Production uses the killable worker runner; async fallback serves trusted test doubles. */
async function collectWithDeadline(
  adapter: CollectorAdapter, target: string, context: CollectionContext, timeoutMs: number,
): Promise<ObservationInput[]> {
  if (adapter.isolated) return adapter.collect(target, { ...context, timeoutMs });
  const child = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value: ObservationInput[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      child.abort();
      finish(new Error('Collection cancelled'));
    };
    const timer = setTimeout(() => {
      child.abort();
      finish(new Error('Collection deadline exceeded'));
    }, timeoutMs);
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) { onAbort(); return; }
    const onBatch = (observations: ObservationInput[]) => {
      if (settled || child.signal.aborted || context.signal.aborted) return;
      context.onBatch?.(observations);
    };
    const onProgress = (progress: DiscoveryProgress) => {
      if (settled || child.signal.aborted || context.signal.aborted) return;
      context.onProgress?.(progress);
    };
    const onOutcomes = (outcomes: DiscoveryOutcome[]) => {
      if (settled || child.signal.aborted || context.signal.aborted) return;
      context.onOutcomes?.(outcomes);
    };
    Promise.resolve().then(() => adapter.collect(target, { ...context, signal: child.signal, onBatch, onProgress, onOutcomes }))
      .then((value) => finish(null, value), () => finish(new Error('Collector unavailable')));
  });
}

type Active = { job: Job; controller: AbortController; reason: JobStatus | null; done: Promise<void> };

export class JobManager {
  private active: Active | null = null;
  private closing = false;
  private storageFailed = false;

  get busy(): boolean { return this.active !== null; }

  get problem(): string | null {
    return this.storageFailed
      ? 'Job state could not be saved. Collection is disabled; activity may be incomplete. Check local storage and restart Neo.'
      : this.adapter.problem ?? this.discoveryAdapter?.problem ?? null;
  }

  private persist(job: Job): void {
    try { this.store.saveJob(job); }
    catch {
      this.storageFailed = true;
      throw new RequestError(503, 'Job state could not be saved. Check local storage and restart Neo.');
    }
  }

  constructor(private readonly store: Store, private readonly adapter: CollectorAdapter, private readonly probeTimeoutMs = 750, private readonly discoveryAdapter?: CollectorAdapter) {
    for (const job of store.jobs()) {
      if (job.status === 'queued' || job.status === 'running') {
        store.saveJob({ ...job, status: 'interrupted', finishedAt: Date.now(),
          errors: [...job.errors, 'Application stopped before this job finished. Partial results were retained.'] });
      }
    }
  }

  start(requestId: string, spec: JobSpec): Job {
    if (this.closing) throw new RequestError(503, 'Application is shutting down');
    if (this.problem) throw new RequestError(503, this.problem);
    if (spec.discovery && !this.discoveryAdapter) throw new RequestError(503, 'Discovery is unavailable');
    const existing = this.store.jobByRequest(requestId);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new RequestError(409, 'requestId already belongs to different job settings');
      return existing;
    }
    if (this.store.hasRequestId(requestId)) throw new RequestError(409, 'This requestId was used previously. Start with a new requestId.');
    if (this.active) throw new RequestError(409, 'Another collection is active. Cancel it or wait for it to finish.');
    if (this.store.jobs().length >= MAX_JOBS) throw new RequestError(409, 'Job capacity reached. See the reset instructions.');
    const targets = spec.scope.filter((target) => !spec.exclusions.includes(target));
    const job: Job = {
      id: randomUUID(), requestId, spec: structuredClone(spec), status: 'queued',
      synthetic: !spec.discovery || this.discoveryAdapter?.id !== 'discovery-v1',
      createdAt: Date.now(), startedAt: null, finishedAt: null,
      completedTargets: 0, totalTargets: targets.length * spec.maxCycles,
      cyclesCompleted: 0, observationsAdded: 0, errors: [],
    };
    this.persist(job);
    const active: Active = { job, controller: new AbortController(), reason: null, done: Promise.resolve() };
    this.active = active;
    // Reserve the one available slot synchronously; run after the submission returns.
    active.done = Promise.resolve().then(() => this.run(active, targets))
      .catch(() => { this.storageFailed = true; })
      .finally(() => { if (this.active === active) this.active = null; });
    return structuredClone(job);
  }

  cancel(id: string): Job {
    const job = this.store.job(id);
    if (!job) throw new RequestError(404, 'Job not found');
    if (this.active?.job.id === id) {
      this.active.reason = 'cancelled';
      this.active.controller.abort();
    }
    return this.store.job(id)!;
  }

  private async run(active: Active, targets: string[]): Promise<void> {
    const job = active.job;
    const signal = active.controller.signal;
    let completedWithIssues=false;
    job.status = 'running';
    job.startedAt = Date.now();
    const deadline = setTimeout(() => {
      active.reason ??= 'timed_out';
      active.controller.abort();
    }, job.spec.maxDurationMs);
    try {
      this.persist(job);
      for (let cycle = 0; cycle < job.spec.maxCycles; cycle++) {
        for (const target of targets) {
          signal.throwIfAborted();
          try {
            const ingest = (observations: ObservationInput[]) => {
              signal.throwIfAborted();
              if (observations.length > 100 || observations.some((item) => !observationAllowed(target, item, job.id))) {
                throw new Error('Adapter returned an invalid result');
              }
              job.observationsAdded += this.store.ingest(observations);
              this.persist(job);
            };
            const adapter = job.spec.discovery ? this.discoveryAdapter! : this.adapter;
            const observations = await collectWithDeadline(adapter, target,
              { signal, now: Date.now(), cycle, jobId: job.id, discovery: job.spec.discovery, onBatch: ingest,
                onProgress: (progress) => { signal.throwIfAborted(); job.discoveryProgress = progress; this.persist(job); },
                onOutcomes: (outcomes) => { signal.throwIfAborted(); job.discoveryOutcomes=outcomes; this.persist(job); },
              }, job.spec.discovery ? 60000 : this.probeTimeoutMs);
            signal.throwIfAborted();
            if (observations.length) ingest(observations);
          } catch (error) {
            if (signal.aborted) throw new Error('Job stopped');
            if(error instanceof CollectionIssues) {completedWithIssues=true;}
            else if (job.errors.length < 20) job.errors.push(job.spec.discovery
              ? 'Discovery failed, timed out or reached a response cap. Saved address-candidate evidence and prior observations were retained.'
              : 'One synthetic collection failed or timed out; useful partial results and prior evidence were retained.');
          }
          job.completedTargets++;
          this.persist(job);
        }
        job.cyclesCompleted++;
        this.persist(job);
        if (cycle + 1 < job.spec.maxCycles) await delay(job.spec.intervalMs, undefined, { signal });
      }
      job.status = job.errors.length ? 'failed' : completedWithIssues ? 'completed_with_issues' : 'completed';
    } catch {
      job.status = active.reason ?? 'failed';
      if (!active.reason && job.errors.length < 20) job.errors.push('Collection stopped unexpectedly. Partial results were retained.');
    } finally {
      clearTimeout(deadline);
      job.finishedAt = Date.now();
      try { this.persist(job); }
      finally { if (this.active === active) this.active = null; }
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.reason ??= 'interrupted';
    active.controller.abort();
    await active.done;
  }
}
