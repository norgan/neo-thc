import {benchmarkComparisons,DNS_BENCHMARK_LIMITS,type DnsBenchmarkPlan} from '../shared/dns-benchmark.js';
import type {JobSpec} from '../shared/types.js';
import {diagnosticHostname} from './diagnostics.js';
import {RequestError} from './jobs.js';
import {benchmarkResolverProblem,canonicalDnsAddress} from './diagnostic-options.js';

/** Published provider endpoints, verified 27 October 2026; selection is reviewed before transmission. */
export const PUBLIC_DNS_BENCHMARK_RESOLVERS = [
  {label:'Cloudflare (unfiltered), IPv4',address:'1.1.1.1'},
  {label:'Cloudflare (unfiltered), IPv6',address:'2606:4700:4700::1111'},
  {label:'Quad9 (threat blocking), IPv4',address:'9.9.9.9'},
  {label:'Quad9 (threat blocking), IPv6',address:'2620:fe::fe'},
  {label:'AdGuard (ad and tracker blocking), IPv4',address:'94.140.14.14'},
  {label:'AdGuard (ad and tracker blocking), IPv6',address:'2a10:50c0::ad1:ff'},
] as const;

export function parseDnsBenchmark(body:unknown,confirm=false):{requestId:string;plan:DnsBenchmarkPlan;spec:JobSpec} {
  if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError(400,'Enter DNS benchmark settings.');
  const row=body as Record<string,unknown>;
  const allowed=['requestId','hostnames','resolvers','port','protocols','recordTypes','requests','timeoutSeconds','confirmed'];
  if(Object.keys(row).some(key=>!allowed.includes(key))||typeof row.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(row.requestId))
    throw new RequestError(400,'Benchmark settings or request ID are invalid.');
  if(row.confirmed!==undefined&&typeof row.confirmed!=='boolean')throw new RequestError(400,'Invalid confirmation.');
  if(confirm&&row.confirmed!==true)throw new RequestError(400,'Review and approve the exact benchmark names and DNS recipients first.');
  function strings(value:unknown,min:number,max:number,label:string):string[]{
    if(!Array.isArray(value)||value.length<min||value.length>max||value.some(item=>typeof item!=='string')||new Set(value).size!==value.length)
      throw new RequestError(400,label);
    return value as string[];
  }
  const hostnames=strings(row.hostnames,1,DNS_BENCHMARK_LIMITS.maxHostnames,'Choose one to three unique full hostnames.').map(diagnosticHostname).sort();
  if(new Set(hostnames).size!==hostnames.length)throw new RequestError(400,'Choose each hostname only once.');
  const resolvers=strings(row.resolvers,1,DNS_BENCHMARK_LIMITS.maxResolvers,'Choose one to sixteen unique literal DNS server addresses.').map(address=>{
    const problem=benchmarkResolverProblem(address);if(problem)throw new RequestError(400,problem);
    return canonicalDnsAddress(address);
  }).sort();
  if(new Set(resolvers).size!==resolvers.length)throw new RequestError(400,'Choose each resolver only once, including equivalent IPv6 spellings.');
  function integer(value:unknown,min:number,max:number,label:string):number{
    if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new RequestError(400,label);
    return value;
  }
  const protocols=strings(row.protocols,1,2,'Choose UDP, TCP, or both.').sort();
  if(protocols.some(value=>value!=='udp'&&value!=='tcp'))throw new RequestError(400,'Only UDP and TCP DNS are supported.');
  const recordTypes=strings(row.recordTypes,1,2,'Choose A, AAAA, or both.').sort();
  if(recordTypes.some(value=>value!=='A'&&value!=='AAAA'))throw new RequestError(400,'Only A and AAAA address queries are supported.');
  const plan:DnsBenchmarkPlan={hostnames,resolvers,
    port:integer(row.port,1,65535,'Choose a DNS port from 1 to 65535.'),
    protocols:protocols as DnsBenchmarkPlan['protocols'],recordTypes:recordTypes as DnsBenchmarkPlan['recordTypes'],
    requests:integer(row.requests,1,DNS_BENCHMARK_LIMITS.maxRequests,'Choose one to fifty lookup iterations per comparison.'),
    timeoutSeconds:integer(row.timeoutSeconds,1,DNS_BENCHMARK_LIMITS.maxTimeoutSeconds,'Choose a one or two second lookup timeout.'),
  };
  return {requestId:row.requestId,plan,spec:{mode:'initial',scope:['diagnostics:dns-benchmark'],exclusions:[],intervalMs:1000,maxCycles:1,
    maxDurationMs:DNS_BENCHMARK_LIMITS.maxDurationMs,dnsBenchmark:plan}};
}

export function dnsBenchmarkPreview(plan:DnsBenchmarkPlan){
  const comparisons=benchmarkComparisons(plan).length;
  return {plan,comparisons,lookupIterations:comparisons*plan.requests,maxDurationMs:DNS_BENCHMARK_LIMITS.maxDurationMs,
    warning:'Every selected DNS server receives every selected hostname. Resolvers may forward queries upstream. Repeated lookups warm caches; latency and reliability do not establish filtering, local-name support, browser DNS behaviour or overall network health. No DNS settings are changed.'};
}
