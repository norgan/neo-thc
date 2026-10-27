/** Pinned upstream contract. Resolver transport and question type are independent. */
export const DNS_BENCH_VERSION = '0.14.0';
export const DNS_BENCHMARK_LIMITS = {
  maxResolvers: 16,
  maxHostnames: 3,
  maxRequests: 50,
  maxTimeoutSeconds: 2,
  maxDurationMs: 180_000,
  processTimeoutMs: 30_000,
  concurrency: 4,
  maxOutputBytes: 65_536,
} as const;

export interface DnsBenchmarkPlan {
  hostnames: string[];
  resolvers: string[];
  port: number;
  protocols: ('udp' | 'tcp')[];
  recordTypes: ('A' | 'AAAA')[];
  requests: number;
  timeoutSeconds: number;
}

export interface DnsBenchmarkCapability {
  available: boolean;
  version: string | null;
  reason: string | null;
}

export interface DnsBenchmarkResult {
  hostname: string;
  resolver: string;
  port: number;
  protocol: 'udp' | 'tcp';
  recordType: 'A' | 'AAAA';
  family: 4 | 6;
  status: 'complete' | 'no_responses' | 'unavailable' | 'invalid_output' | 'timed_out';
  totalRequests: number | null;
  successfulRequests: number | null;
  successPercent: number | null;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  lastResolvedAddress: string | null;
  issue: string | null;
}

export interface DnsBenchmarkReport {
  complete: boolean;
  tool: 'dns-bench';
  toolVersion: string;
  vantage: string;
  startedAt: number;
  updatedAt: number;
  totalComparisons: number;
  results: DnsBenchmarkResult[];
}

export interface DnsBenchmarkComparison {
  hostname: string;
  resolver: string;
  protocol: 'udp' | 'tcp';
  recordType: 'A' | 'AAAA';
}

export function benchmarkComparisons(plan: DnsBenchmarkPlan): DnsBenchmarkComparison[] {
  return plan.hostnames.flatMap(hostname => plan.protocols.flatMap(protocol =>
    plan.recordTypes.flatMap(recordType => plan.resolvers.map(resolver => ({hostname, resolver, protocol, recordType})))));
}
