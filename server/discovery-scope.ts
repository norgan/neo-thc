import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import type { DiscoveryInterface, DiscoveryMethod, DiscoveryPlan, JobSpec } from '../shared/types.js';
import { RequestError } from './jobs.js';

export const DISCOVERY_LIMITS = Object.freeze({
  addresses: 256, ports: 8, tcpAttempts: 1024, tcpConcurrency: 16,
  tcpTimeoutMs: 400, dnsConcurrency: 8, dnsTimeoutMs: 500,
  datagramsPerMethod: 1, receivedDatagramsPerMethod: 256,
  datagramBytes: 8192, discoveryWindowMs: 2000, jobMs: 60000,
});
const fail = (message: string): never => { throw new RequestError(400, message); };
export function ipv4Number(value: string): number {
  if (!isIPv4(value)) return fail('Use a literal IPv4 address');
  return value.split('.').reduce((result, octet) => (result * 256 + Number(octet)) >>> 0, 0);
}
export const ipv4Text = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
export function cidrRange(value: string) {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(value);
  if (!match) return fail('Use an explicit IPv4 CIDR');
  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32) return fail('Invalid IPv4 prefix');
  const number = ipv4Number(match[1]);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(number / size) * size;
  return { first, last: first + size - 1, prefix, size, cidr: ipv4Text(first) + '/' + prefix };
}
export function localInterfaces(): DiscoveryInterface[] {
  const result: DiscoveryInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || !isIPv4(address.address) || !isIPv4(address.netmask)) continue;
      const mask = ipv4Number(address.netmask);
      const bits = mask.toString(2).padStart(32, '0');
      if (!/^1*0*$/.test(bits)) continue;
      const prefix = bits.indexOf('0') < 0 ? 32 : bits.indexOf('0');
      if (prefix === 0) continue;
      const cidr = cidrRange(address.address + '/' + prefix).cidr;
      const id = createHash('sha256').update(name + '/' + address.address + '/' + address.netmask).digest('hex').slice(0, 20);
      result.push({ id, name, address: address.address, netmask: address.netmask, cidr });
    }
  }
  return result.slice(0, 32);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a discovery settings object');
  return value as Record<string, unknown>;
}
export function parseDiscovery(body: unknown, interfaces: readonly DiscoveryInterface[], requireConfirmation = false) {
  const input = object(body);
  if (Object.keys(input).some((key) => !['requestId', 'interfaceId', 'cidr', 'methods', 'ports', 'resolver', 'linkScopeConfirmed', 'confirmScope'].includes(key))) return fail('Unknown discovery setting');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) return fail('Choose a valid request ID');
  const selected = interfaces.find((item) => item.id === input.interfaceId);
  if (!selected) return fail('Select a current local IPv4 interface');
  if (typeof input.cidr !== 'string') return fail('Select an explicit IPv4 CIDR');
  const range = cidrRange(input.cidr);
  const link = cidrRange(selected.cidr);
  if (range.size > 256 || range.first < link.first || range.last > link.last) return fail('Choose at most 256 IPv4 addresses on the selected interface subnet');
  if (range.first < ipv4Number('1.0.0.0') || range.last >= ipv4Number('224.0.0.0') ||
    (range.first <= ipv4Number('127.255.255.255') && range.last >= ipv4Number('127.0.0.0'))) return fail('Loopback, unspecified and multicast targets are unavailable');
  const allowed: DiscoveryMethod[] = ['tcp', 'ptr', 'mdns', 'nbns', 'ssdp'];
  if (!Array.isArray(input.methods) || !input.methods.length || input.methods.length > 5 ||
    input.methods.some((value) => !allowed.includes(value as DiscoveryMethod)) || new Set(input.methods).size !== input.methods.length) return fail('Explicitly select discovery methods');
  const methods = [...input.methods as DiscoveryMethod[]].sort();
  const ports = input.ports ?? [];
  if (!Array.isArray(ports) || ports.length > 8 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    new Set(ports).size !== ports.length || (methods.includes('tcp') ? ports.length === 0 : ports.length !== 0)) return fail('Select one to eight TCP ports only when TCP probing is enabled');
  const targets: string[] = [];
  for (let n = range.first; n <= range.last; n++) {
    // Never connect to the selected link's network/broadcast address or the collector itself.
    if (link.prefix <= 30 && (n === link.first || n === link.last)) continue;
    if (n === ipv4Number(selected.address)) continue;
    targets.push(ipv4Text(n));
  }
  if (!targets.length) return fail('The scope contains no remote host addresses');
  if (targets.length * ports.length > 1024) return fail('Reduce targets or ports to at most 1024 TCP connection attempts');
  let resolver: string | null = null;
  if (methods.includes('ptr')) {
    if (typeof input.resolver !== 'string' || !isIPv4(input.resolver)) return fail('Choose the exact IPv4 DNS resolver; no default resolver is used');
    resolver = input.resolver;
    const number = ipv4Number(resolver);
    if (number < link.first || number > link.last || number === link.first || number === link.last) return fail('For this first release the DNS resolver must be on the selected local subnet');
  } else if (input.resolver !== undefined && input.resolver !== '') return fail('A resolver is only accepted when reverse DNS is selected');
  const linkMethod = methods.includes('mdns') || methods.includes('nbns') || methods.includes('ssdp');
  if (input.linkScopeConfirmed !== undefined && typeof input.linkScopeConfirmed !== 'boolean') return fail('Invalid link-scope confirmation');
  if (linkMethod && (link.prefix < 24 || link.prefix > 30 || range.cidr !== link.cidr || input.linkScopeConfirmed !== true)) return fail('Multicast/broadcast requires the entire selected /24–/30 interface subnet and explicit link-wide approval');
  if (linkMethod && interfaces.some((other) => {
    if (other.id === selected.id) return false;
    const otherRange = cidrRange(other.cidr);
    return otherRange.first <= link.last && otherRange.last >= link.first;
  })) return fail('Overlapping local interface subnets make link-wide discovery ambiguous');
  if (input.confirmScope !== undefined && typeof input.confirmScope !== 'boolean') return fail('Invalid scope confirmation');
  if (requireConfirmation && input.confirmScope !== true) return fail('Preview and explicitly confirm this discovery scope first');
  const plan: DiscoveryPlan = {
    interface: { ...selected }, cidr: range.cidr, targets, methods, ports: [...ports].sort((a, b) => a - b),
    resolver, linkScopeConfirmed: linkMethod,
    tcpBudget: targets.length * ports.length, dnsBudget: methods.includes('ptr') ? targets.length : 0,
    datagramBudget: Number(methods.includes('mdns')) + Number(methods.includes('nbns')) + Number(methods.includes('ssdp')),
  };
  const spec: JobSpec = { mode: 'initial', scope: ['discovery:ipv4'], exclusions: [], intervalMs: 1000, maxCycles: 1, maxDurationMs: 60000, discovery: plan };
  return { requestId: input.requestId, plan, spec };
}
