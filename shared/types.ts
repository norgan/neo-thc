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
  synthetic: boolean;
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
  discovery?: DiscoveryPlan;
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
  discoveryProgress?: DiscoveryProgress;
}
export interface FixtureTarget {
  key: string;
  label: string;
  defaultSelected?: boolean;
}
export interface Snapshot {
  synthetic: boolean;
  collectionError: string | null;
  assets: Asset[];
  jobs: Job[];
  targets: FixtureTarget[];
}

export type DiscoveryMethod = 'tcp' | 'ptr' | 'mdns' | 'nbns' | 'ssdp';
export interface DiscoveryInterface { id: string; name: string; address: string; netmask: string; cidr: string; }
export interface DiscoveryPlan {
  interface: DiscoveryInterface;
  cidr: string;
  targets: string[];
  methods: DiscoveryMethod[];
  ports: number[];
  resolver: string | null;
  linkScopeConfirmed: boolean;
  tcpBudget: number;
  dnsBudget: number;
  datagramBudget: number;
}
export interface DiscoveryProgress {
  addressesCompleted: number; totalAddresses: number;
  tcpCompleted: number; dnsCompleted: number; datagramsSent: number;
}
