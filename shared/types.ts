import type {DnsBenchmarkPlan,DnsBenchmarkReport} from './dns-benchmark.js';

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
  network?: NetworkFacts;
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
  diagnostic?: DiagnosticPlan;
  dnsBenchmark?: DnsBenchmarkPlan;
}
export type JobStatus =
  | 'queued' | 'running' | 'completed' | 'cancelled'
  | 'timed_out' | 'interrupted' | 'failed' | 'completed_with_issues';
export interface Job {
  synthetic?: boolean;
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
  discoveryOutcomes?: DiscoveryOutcome[];
  glancesEnrichment?: GlancesEnrichment;
  diagnosticReport?: DiagnosticReport;
  dnsBenchmarkReport?: DnsBenchmarkReport;
}
export interface FixtureTarget {
  key: string;
  label: string;
  defaultSelected?: boolean;
}
export interface Snapshot {
  runtime: string;
  synthetic: boolean;
  collectionError: string | null;
  assets: Asset[];
  systems?:SystemView[];
  stats?:GlancesStats[];
  statsActive?:string|null;
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
  tcpConcurrency?:number;
  tcpAttemptLimit?:number;
  maxDurationMs?:number;
  estimatedMaxMs?:number;
  glances?: {scheme:'http'|'https';maxEndpoints:2;maxQueries:7;maxRequests:12;resolveMs:8000};
}
export interface DiscoveryProgress {
  addressesCompleted: number; totalAddresses: number;
  tcpCompleted: number; dnsCompleted: number; datagramsSent: number;
}

export interface ResolverChoice { address: string; supported: boolean; reason: string; }
export interface DiscoveryDefaults { source: string; resolver: string; servers: ResolverChoice[]; }

export type DiscoveryIssue='access_denied'|'source_unavailable'|'network_unreachable'|'timeout'|'refused'|'response_cap'|'io_error';
export interface DiscoveryOutcome {
  method:DiscoveryMethod; attempted:number; completed:number; responses:number; durationMs:number; issues:DiscoveryIssue[];
}

export interface NetworkFacts {
  address:string; ptrNames:string[]; ptrState:string;
  ports:{port:number;state:string}[]; mdns:string[]; ssdp:string[]; nbns:boolean;
}
export interface KnownService {
  key:string; name:string; category:string; confidence:'advertised'|'port-hint';
  evidence:string; observedAt:number; port?:number;
}
export interface SystemView {
  key:string; address:string; vantage:string; displayName:string; nameBasis:'PTR'|'address';
  nameObservedAt:number|null; currentAssetId:string; assetIds:string[]; attemptCount:number;
  responded:boolean; respondedLatest:boolean; lastResponseAt:number|null; lastAttemptAt:number;
  services:KnownService[]; roles:{label:string;confidence:'advertised'|'port-hint';evidence:string}[];
  openPorts:number[]; names:string[]; identityChanged:boolean;
}
export interface GlancesStats {
  id:string; requestId:string; assetId:string; source:'glances-api-v4'; endpoint:string;
  sourceAddress:string; sampledAt:number; version:string|null; status:'complete'|'partial'|'failed';
  hostname:string|null; operatingSystem:string|null; cpuPercent:number|null;
  memory:{percent:number;totalBytes:number;availableBytes:number}|null;
  filesystems:{mount:string;type:string|null;sizeBytes:number;freeBytes:number;usedBytes:number;percent:number}[]|null;
  uptime:string|null; issues:{section:string;code:string}[];
}

export interface GlancesCandidate {
  address:string; instance:string; port:number|null; protocol:'rest'|'rpc'|'unknown';
  ttlMs:number; issue:string|null;
}
export interface GlancesResolution {
  candidates:GlancesCandidate[]; datagramsSent:number; packetsReceived:number; omitted:number; issues:string[];
}
export interface GlancesEnrichment {
  phase:'resolving'|'reading'|'completed'|'cancelled';
  datagramsSent:number; packetsReceived:number; omitted:number; issues:string[];
  endpoints:(GlancesCandidate&{status:'pending'|'reading'|'complete'|'partial'|'failed'|'skipped';snapshotId?:string;reason?:string})[];
}

export type DiagnosticPlan =
  | {kind:'dns';hostname:string;resolvers:string[];port?:number;systemLookup:boolean}
  | {kind:'connect';hostname:string;dnsJobId:string;addresses:string[];port:number;tls:boolean}
  | {kind:'internet';hostname:string;resolvers:string[];port:number;gateway:string|null;download:boolean};
export type DnsOutcome='answer'|'no_data'|'nxdomain'|'not_found'|'servfail'|'refused'|'timeout'|'cancelled'|'unavailable'|'response_cap';
export type TcpOutcome='connected'|'refused'|'timeout'|'unreachable'|'unavailable';
export type TlsOutcome='verified'|'certificate_error'|'handshake_error'|'timeout'|'not_requested'|'not_reached';
export interface DnsCheck {
  kind:'dns';source:string;recordType:'A'|'AAAA'|'system';status:DnsOutcome;durationMs:number;port?:number;hostname?:string;
  answers:{address:string;family:4|6;ttl:number|null}[];
}
export interface ConnectionCheck {
  kind:'connect';address:string;family:4|6;port:number;sourceAddress:string|null;tcp:TcpOutcome;tls:TlsOutcome;durationMs:number;
}
export interface DiagnosticFinding {code:string;title:string;detail:string;nextStep:string;}
export type PingStatus='reply'|'timeout'|'too_big'|'unreachable'|'unavailable';
export interface PingSample {status:PingStatus;rttMs:number|null;}
export type InternetCheck =
  | {kind:'settings';status:'read'|'unavailable';gateway:string|null;interfaces:{name:string;family:4|6;mtu:number;defaultRoute:boolean;dhcp:boolean|null;dnsSuffix?:string}[]}
  | {kind:'latency';target:string;samples:PingSample[];durationMs:number}
  | {kind:'mtu';target:string;status:'at_least_1500'|'reduced'|'inconclusive';mtu:number|null;probes:{payload:number;status:PingStatus}[];durationMs:number}
  | {kind:'transfer';status:'complete'|'deadline'|'http_error'|'tls_error'|'unavailable'|'byte_cap';bytes:number;durationMs:number;mbps:number|null};
export interface DiagnosticReport {
  complete:boolean;
  hostname:string;kind:'dns'|'connect'|'internet';vantage:string;startedAt:number;updatedAt:number;
  dns:DnsCheck[];connections:ConnectionCheck[];findings:DiagnosticFinding[];internet?:InternetCheck[];
}
