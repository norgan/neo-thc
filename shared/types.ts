export type Health = 'healthy' | 'unhealthy' | 'stopped' | 'unknown';
export type Freshness = 'fresh' | 'stale' | 'unknown';
export interface Identifier {
  kind: 'ip' | 'mac' | 'platform-id';
  value: string;
}
export interface ServiceEvidence {
  name: string;
  status: Health;
  note: string;
}
export interface ObservationInput {
  id: string;
  subjectKey: string;
  label: string;
  kind: string;
  source: string;
  vantage: string;
  observedAt: number;
  ttlMs: number;
  status: Health;
  note: string;
  identifiers: Identifier[];
  services: ServiceEvidence[];
}
export interface Observation extends ObservationInput {
  assetId: string;
  receivedAt: number;
}
export interface Asset {
  id: string;
  subjectKey: string;
  label: string;
  kind: string;
  identityConfidence: 'source-scoped';
  identityWarnings: string[];
  freshness: Freshness;
  health: Health;
  latest: Observation | null;
}
export interface JobSpec {
  mode: 'initial' | 'live';
  scope: string[];
  exclusions: string[];
  intervalMs: number;
  maxCycles: number;
  maxDurationMs: number;
}
export type JobStatus =
  | 'queued' | 'running' | 'completed' | 'cancelled'
  | 'timed_out' | 'interrupted' | 'failed';
export interface Job {
  id: string;
  requestId: string;
  spec: JobSpec;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  completedTargets: number;
  totalTargets: number;
  cyclesCompleted: number;
  observationsAdded: number;
  errors: string[];
}
export interface FixtureTarget {
  key: string;
  label: string;
}
export interface Snapshot {
  synthetic: true;
  assets: Asset[];
  jobs: Job[];
  targets: FixtureTarget[];
}
