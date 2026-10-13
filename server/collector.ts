import { randomUUID } from 'node:crypto';
import type { FixtureTarget, ObservationInput, Health, ServiceEvidence } from '../shared/types.js';

export interface CollectionContext {
  signal: AbortSignal;
  now: number;
  cycle: number;
  timeoutMs?: number;
  onBatch?: (observations: ObservationInput[]) => void;
}

/** No credentials, configuration, execution, or remediation operations exist here. */
export interface CollectorAdapter {
  readonly id: string;
  readonly isolated?: true;
  readonly problem?: string | null;
  readonly capabilities: readonly ['fixture-observations'];
  readonly targets: readonly FixtureTarget[];
  collect(target: string, context: CollectionContext): Promise<ObservationInput[]>;
}

export const fixtureTargets: readonly FixtureTarget[] = [
  { key: 'fixture:gateway', label: 'Demo gateway' },
  { key: 'fixture:nas', label: 'Demo storage' },
  { key: 'fixture:vm', label: 'Demo stopped VM' },
  { key: 'fixture:unknown', label: 'Demo unclassified device' },
  { key: 'fixture:old-lease', label: 'Demo previous address holder' },
  { key: 'fixture:new-lease', label: 'Demo current address holder' },
];

export class FixtureCollector implements CollectorAdapter {
  readonly id = 'fixture-v1';
  readonly capabilities = ['fixture-observations'] as const;
  readonly targets = fixtureTargets;

  async collect(target: string, context: CollectionContext): Promise<ObservationInput[]> {
    return fixtureObservations(target, context);
  }
}

/** Trusted synthetic timestamp policy preserves the historical address example. */
export function fixtureObservations(target: string, context: CollectionContext): ObservationInput[] {
    context.signal.throwIfAborted();
    const found = fixtureTargets.find((item) => item.key === target);
    if (!found) throw new Error('Unsupported fixture target');
    const status: Health = target === 'fixture:nas' ? 'unhealthy'
      : target === 'fixture:vm' ? 'stopped'
      : target === 'fixture:unknown' ? 'unknown' : 'healthy';
    const services: ServiceEvidence[] = target === 'fixture:nas' ? [
      { name: 'ping', status: 'healthy', note: 'Synthetic reachability result; not a service-health conclusion.' },
      { name: 'SMB', status: 'healthy', note: 'Synthetic protocol response.' },
      { name: 'NFS', status: 'unhealthy', note: 'Synthetic NFS failure. Root cause is unknown.' },
    ] : [];
    const index = fixtureTargets.findIndex((item) => item.key === target);
    const isLease = target.endsWith('lease');
    const observedAt = target === 'fixture:old-lease' ? context.now - 120_000 : context.now;
    return [{
      id: randomUUID(),
      subjectKey: target,
      label: found.label,
      kind: target === 'fixture:nas' ? 'storage' : target === 'fixture:vm' ? 'virtual-machine' : 'device',
      source: 'fixture-v1',
      vantage: 'synthetic-local-demo',
      observedAt,
      ttlMs: 60_000,
      status,
      note: isLease
        ? 'Synthetic address reuse: historical and current claims must remain separate assets.'
        : 'Synthetic observation only. No network traffic was sent.',
      identifiers: [
        { kind: 'platform-id', value: target },
        { kind: 'ip', value: isLease ? '192.0.2.40' : '192.0.2.' + (10 + index) },
      ],
      services,
    }];
}

export function observationAllowed(target: string, observation: ObservationInput): boolean {
  if (target === 'fixture:proxmox-lab') {
    return observation.source === 'proxmox-fixture-v1' &&
      /^demo-lab\/(node\/[a-zA-Z0-9.-]+|(?:qemu|lxc)\/[1-9][0-9]*)$/.test(observation.subjectKey);
  }
  return fixtureTargets.some((item) => item.key === target) &&
    observation.source === 'fixture-v1' && observation.subjectKey === target;
}
