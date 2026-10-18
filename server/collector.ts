import type { FixtureTarget, ObservationInput, DiscoveryPlan, DiscoveryProgress, DiscoveryOutcome } from '../shared/types.js';
export interface CollectionContext {
  signal: AbortSignal;
  now: number;
  cycle: number;
  jobId?: string;
  discovery?: DiscoveryPlan;
  onOutcomes?: (outcomes: DiscoveryOutcome[]) => void;
  onProgress?: (progress: DiscoveryProgress) => void;
  timeoutMs?: number;
  onBatch?: (observations: ObservationInput[]) => void;
}

/** No credentials, configuration, execution, or remediation operations exist here. */
export interface CollectorAdapter {
  readonly id: string;
  readonly isolated?: true;
  readonly problem?: string | null;
  readonly capabilities: readonly ['fixture-observations'] | readonly ['network-observations'];
  readonly targets: readonly FixtureTarget[];
  collect(target: string, context: CollectionContext): Promise<ObservationInput[]>;
}

export function observationAllowed(target: string, observation: ObservationInput, jobId?: string): boolean {
  if (target === 'discovery:ipv4') return ((observation.synthetic === false && observation.source === 'discovery-v1') ||
    (observation.synthetic === true && observation.source === 'discovery-fixture-v1')) &&
    typeof jobId === 'string' && observation.subjectKey.startsWith(jobId + '/');
  if (target === 'fixture:proxmox-lab') {
    return observation.source === 'proxmox-fixture-v1' &&
      /^demo-lab\/(node\/[a-zA-Z0-9.-]+|(?:qemu|lxc)\/[1-9][0-9]*)$/.test(observation.subjectKey);
  }
  return target.startsWith('fixture:') &&
    observation.source === 'fixture-v1' && observation.subjectKey === target;
}

export class CollectionIssues extends Error { constructor() { super('Discovery completed with method issues'); } }
