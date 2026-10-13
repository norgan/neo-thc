import { isIPv4 } from 'node:net';
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema');
  return /** @type {Record<string,unknown>} */ (value);
}
/** @param {unknown} value @param {import('../shared/types.js').DiscoveryPlan} plan */
export function validateResult(value, plan) {
  const row = object(value);
  if (Object.keys(row).some((key) => !['address','ports','dns','mdns','nbns','ssdp','ttlMs'].includes(key)) ||
    typeof row.address !== 'string' || !plan.targets.includes(row.address) || !isIPv4(row.address)) throw new Error('schema');
  if (!Array.isArray(row.ports) || row.ports.length !== plan.ports.length) throw new Error('schema');
  const ports = row.ports.map((unknownPort) => {
    const port = object(unknownPort);
    if (Object.keys(port).some((key) => !['port','state'].includes(key)) || typeof port.port !== 'number' || !plan.ports.includes(port.port) ||
      typeof port.state !== 'string' || !['open','closed','timeout','unreachable','error'].includes(port.state)) throw new Error('schema');
    return { port: port.port, state: port.state };
  });
  if (new Set(ports.map((port) => port.port)).size !== ports.length) throw new Error('schema');
  const dns = object(row.dns);
  if (Object.keys(dns).some((key) => !['state','names'].includes(key)) || typeof dns.state !== 'string' ||
    !['not_requested','answer','no_data','error'].includes(dns.state) || !Array.isArray(dns.names) || dns.names.length > 4 ||
    dns.names.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9._-]{1,253}$/.test(name))) throw new Error('schema');
  if (!plan.methods.includes('ptr') && (dns.state !== 'not_requested' || dns.names.length)) throw new Error('schema');
  if (dns.state !== 'answer' && dns.names.length) throw new Error('schema');
  if (!Array.isArray(row.mdns) || row.mdns.length > 4 || row.mdns.some((name) => typeof name !== 'string' ||
    !/^_[a-z0-9_-]+\._(?:tcp|udp)\.local$/.test(name)) || (!plan.methods.includes('mdns') && row.mdns.length)) throw new Error('schema');
  if (!Array.isArray(row.ssdp) || row.ssdp.length > 1 || row.ssdp.some((claim) => typeof claim !== 'string' ||
    !/^uuid:[A-Za-z0-9-]{8,80}(?:::upnp:rootdevice)?$/.test(claim)) || (!plan.methods.includes('ssdp') && row.ssdp.length)) throw new Error('schema');
  if (typeof row.nbns !== 'boolean' || (!plan.methods.includes('nbns') && row.nbns) ||
    typeof row.ttlMs !== 'number' || !Number.isInteger(row.ttlMs) || row.ttlMs < 1 || row.ttlMs > 60000) throw new Error('schema');
  return { address: row.address, ports, dns: { state: dns.state, names: /** @type {string[]} */ (dns.names) },
    mdns: /** @type {string[]} */ (row.mdns), nbns: row.nbns, ssdp: /** @type {string[]} */ (row.ssdp), ttlMs: row.ttlMs };
}
/** Recheck only host-supplied wire shape. The parent also enforces current interface/CIDR authority.
 * @param {unknown} value @returns {import('../shared/types.js').DiscoveryPlan}
 */
export function validateWirePlan(value) {
  const plan = object(value);
  const iface = object(plan.interface);
  if (typeof iface.address !== 'string' || !isIPv4(iface.address) || typeof iface.netmask !== 'string' || !isIPv4(iface.netmask) ||
    typeof iface.cidr !== 'string' || typeof plan.cidr !== 'string' || !Array.isArray(plan.targets) ||
    plan.targets.length < 1 || plan.targets.length > 256 || plan.targets.some((address) => typeof address !== 'string' || !isIPv4(address)) ||
    new Set(plan.targets).size !== plan.targets.length || !Array.isArray(plan.ports) || plan.ports.length > 64 ||
    plan.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    plan.targets.length * plan.ports.length > 16384 || !Array.isArray(plan.methods) || !plan.methods.length ||
    plan.methods.some((method) => !['tcp','ptr','mdns','nbns','ssdp'].includes(method)) ||
    (plan.tcpConcurrency!==undefined&&(typeof plan.tcpConcurrency!=='number'||![8,16,32].includes(plan.tcpConcurrency)))||
    (plan.maxDurationMs!==undefined&&(typeof plan.maxDurationMs!=='number'||![60000,120000,240000,480000].includes(plan.maxDurationMs)))||
    (plan.resolver !== null && (typeof plan.resolver !== 'string' || !isIPv4(plan.resolver)))) throw new Error('schema');
  return /** @type {import('../shared/types.js').DiscoveryPlan} */ (/** @type {unknown} */ (plan));
}
