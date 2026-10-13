import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { CollectorAdapter, CollectionContext } from './collector.js';
import type { DiscoveryInterface, DiscoveryPlan, DiscoveryProgress, ObservationInput } from '../shared/types.js';
import { localInterfaces, parseDiscovery } from './discovery-scope.js';
import { validateResult } from './discovery-result.mjs';

export function discoveryObservation(raw: unknown, plan: DiscoveryPlan, jobId: string, synthetic = false, attemptStartedAt = Date.now()): ObservationInput {
  const value = validateResult(raw, plan);
  const replies = value.ports.some((port) => port.state === 'open' || port.state === 'closed') || value.mdns.length > 0 || value.nbns || value.ssdp.length > 0;
  const dns = value.dns.names.length ? ' Unverified PTR claims: ' + value.dns.names.join(', ') + '.' : ' PTR outcome: ' + value.dns.state + '.';
  return {
    id: randomUUID(), synthetic, subjectKey: jobId + '/' + value.address,
    label: 'Address candidate ' + value.address, kind: 'address-candidate',
    source: synthetic ? 'discovery-fixture-v1' : 'discovery-v1',
    vantage: 'interface ' + plan.interface.address,
    // Conservative aggregate age: advertisements may wait behind later unicast probes.
    observedAt: value.mdns.length || value.ssdp.length ? attemptStartedAt : Date.now(), ttlMs: value.mdns.length || value.ssdp.length ? Math.min(value.ttlMs, 10000) : 60000,
    status: 'unknown',
    note: (synthetic ? 'Synthetic discovery test fixture. ' : 'Real scoped network attempt. ') +
      (replies ? 'A network response or advertisement was observed; identity and health remain unverified.' : 'No direct response was observed; this is not a confirmed device.') +
      dns + (plan.resolver ? ' Resolver: ' + plan.resolver + ' (PTR; UDP/TCP 53; no follow-up name lookup).' : '') +
      (value.mdns.length ? ' Unauthenticated mDNS service-type claims: ' + value.mdns.join(', ') + '; may describe proxied services; not full instance discovery.' : '') +
      (value.ssdp.length ? ' Unauthenticated SSDP root-device claims: ' + value.ssdp.join(', ') + '; advertised URLs were discarded, not fetched.' : '') +
      (value.nbns ? ' Legacy NetBIOS browse-master response; limited coverage, not general endpoint enumeration.' : '') +
      ' Identity is this job plus address only; later jobs remain separate to avoid IP-reuse merges. Closed/refused ports can reflect a firewall. Silence is inconclusive.',
    identifiers: [{ kind: 'ip', value: value.address }],
    services: value.ports.map((port) => ({
      name: 'TCP ' + port.port, status: 'unknown',
      note: 'Connect result: ' + port.state + '. No payload, banner or service-health test was performed.',
    })),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid discovery message');
  return value as Record<string, unknown>;
}
/** Production defaults to real sockets; the internal test seam cannot be set by API or environment. */
export class DiscoveryCollector implements CollectorAdapter {
  readonly id = 'discovery-v1';
  readonly isolated = true as const;
  readonly capabilities = ['network-observations'] as const;
  readonly targets = [];
  private active: Worker | null = null;
  private disabled = false;
  constructor(private readonly testMode = false, private readonly interfaces = localInterfaces,
    private readonly fixtureScenario: 'complete' | 'hold-after-first' | 'late-after-done' = 'complete') {}
  get problem() { return this.disabled ? 'Discovery worker cleanup failed. Restart before collecting again.' : null; }

  async collect(target: string, context: CollectionContext): Promise<ObservationInput[]> {
    context.signal.throwIfAborted();
    if (target !== 'discovery:ipv4' || !context.discovery || !context.jobId || this.active || this.disabled) throw new Error('Discovery unavailable');
    if (!this.testMode && this.fixtureScenario !== 'complete') throw new Error('Invalid discovery fixture');
    const attemptStartedAt = Date.now();
    const plan = context.discovery;
    const current = parseDiscovery({
      requestId: context.jobId, interfaceId: plan.interface.id, cidr: plan.cidr,
      methods: plan.methods, ports: plan.ports, resolver: plan.resolver ?? undefined,
      linkScopeConfirmed: plan.linkScopeConfirmed, confirmScope: true,
    }, this.interfaces(), true).plan;
    if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('Discovery interface or scope changed');
    const attemptId = randomUUID();
    const worker = new Worker(new URL('./discovery-worker.mjs', import.meta.url), {
      workerData: { v:1, attemptId, plan, testMode:this.testMode, fixtureScenario:this.fixtureScenario }, execArgv:[], env:{},
      resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:4},
      stdout:true, stderr:true,
    });
    this.active = worker; worker.stdout.resume(); worker.stderr.resume();
    const seen = new Set<string>();
    const collected: ObservationInput[] = [];
    let previous: DiscoveryProgress = { addressesCompleted:0,totalAddresses:plan.targets.length,tcpCompleted:0,dnsCompleted:0,datagramsSent:0 };
    return new Promise((resolve, reject) => {
      let settled = false, messages = 0;
      const finish = async (error: Error | null) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); context.signal.removeEventListener('abort', abort);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const stopped = await Promise.race([worker.terminate().then(() => true),
            new Promise<boolean>((done) => { timer = setTimeout(() => done(false), 1000); })]);
          if (!stopped) throw new Error('cleanup');
          this.active = null;
        } catch { this.disabled = true; worker.unref(); error = new Error('Discovery cleanup failed'); }
        finally { clearTimeout(timer); }
        if (error) reject(error); else resolve(collected);
      };
      const abort = () => { void finish(new Error('Discovery cancelled')); };
      const deadline = setTimeout(() => { void finish(new Error('Discovery deadline')); }, Math.min(context.timeoutMs ?? 60000, 60000));
      context.signal.addEventListener('abort', abort, { once:true });
      worker.once('error', () => { void finish(new Error('Discovery worker failed')); });
      worker.once('exit', () => { if (!settled) void finish(new Error('Discovery worker exited early')); });
      worker.on('message', (raw: unknown) => {
        if (settled || context.signal.aborted) return;
        try {
          if (++messages > 514 || typeof raw !== 'string' || Buffer.byteLength(raw) > 8192) throw new Error('message');
          const message = object(JSON.parse(raw));
          if (message.v !== 1 || message.attemptId !== attemptId) throw new Error('identity');
          if (message.type === 'batch') {
            if (Object.keys(message).some((key) => !['v','attemptId','type','result'].includes(key))) throw new Error('fields');
            const result = validateResult(message.result, plan);
            if (seen.has(result.address)) throw new Error('duplicate');
            seen.add(result.address);
            const observation = discoveryObservation(result, plan, context.jobId!, this.testMode, attemptStartedAt);
            context.signal.throwIfAborted();
            if (context.onBatch) context.onBatch([observation]); else collected.push(observation);
          } else if (message.type === 'progress') {
            if (Object.keys(message).some((key) => !['v','attemptId','type','progress'].includes(key))) throw new Error('fields');
            const progress = object(message.progress);
            const limits = { addressesCompleted:plan.targets.length,totalAddresses:plan.targets.length,tcpCompleted:plan.tcpBudget,dnsCompleted:plan.dnsBudget,datagramsSent:plan.datagramBudget };
            if (Object.keys(progress).length !== 5 || Object.entries(limits).some(([key, limit]) =>
              typeof progress[key] !== 'number' || !Number.isInteger(progress[key]) || progress[key] < previous[key as keyof DiscoveryProgress] || progress[key] > limit) ||
              progress.totalAddresses !== plan.targets.length || progress.addressesCompleted !== seen.size) throw new Error('progress');
            previous = progress as unknown as DiscoveryProgress;
            context.onProgress?.({...previous});
          } else if (message.type === 'done') {
            if (Object.keys(message).some((key) => !['v','attemptId','type','failures'].includes(key)) || !Array.isArray(message.failures) ||
              message.failures.length > 6 || message.failures.some((code) => !['packet_cap','socket_error','dns_error','tcp_error','deadline','collector_error'].includes(code))) throw new Error('completion');
            void finish(message.failures.length || seen.size !== plan.targets.length ? new Error('Discovery incomplete') : null);
          } else throw new Error('type');
        } catch { void finish(new Error('Invalid discovery result')); }
      });
      if (context.signal.aborted) abort();
    });
  }
}
