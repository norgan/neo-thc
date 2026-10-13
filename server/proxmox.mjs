import { Buffer } from 'node:buffer';

export const PVE_OPERATIONS = Object.freeze({
  'pve.version': Object.freeze({ method: 'GET', path: '/api2/json/version' }),
  'pve.nodes': Object.freeze({ method: 'GET', path: '/api2/json/cluster/resources?type=node' }),
  'pve.guests': Object.freeze({ method: 'GET', path: '/api2/json/cluster/resources?type=vm' }),
});
export const PROXMOX_TARGET = 'fixture:proxmox-lab';
export const PROXMOX_VERSION = '8.4.22';
export const failureCodes = Object.freeze(['schema', 'unsupported_version', 'unauthorized', 'unavailable', 'isolation']);

/** @param {string} code @returns {never} */
function fail(code = 'schema') { throw new Error(code); }
/** @param {unknown} error @returns {string} */
function failure(error) {
  return error instanceof Error && failureCodes.includes(error.message) ? error.message : 'unavailable';
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('schema');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail('schema');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @param {number} max @returns {string} */
function text(value, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return fail('schema');
  return value;
}
/** @param {unknown} raw @returns {Record<string, unknown>} */
function envelope(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262_144) return fail('schema');
  try { return object(JSON.parse(raw)); } catch { return fail('schema'); }
}
/** @param {unknown} raw */
export function parseVersion(raw) {
  const data = object(envelope(raw).data);
  const version = text(data.version, 40);
  const release = text(data.release, 16);
  const repoid = text(data.repoid, 64);
  const parsed = /^(\d+)\.(\d+)\.\d+$/u.exec(version);
  if (!parsed || release !== parsed[1] + '.' + parsed[2] || !/^[a-fA-F0-9]{8,64}$/u.test(repoid)) return fail('schema');
  // One source-derived synthetic profile. This is not a live compatibility claim.
  if (version !== PROXMOX_VERSION || release !== '8.4') return fail('unsupported_version');
  return { version, release };
}

/**
 * @typedef {object} Resource
 * @property {string} id
 * @property {'node'|'qemu'|'lxc'} type
 * @property {string} node
 * @property {number|null} vmid
 * @property {string} label
 * @property {string} platformState
 * @property {boolean} template
 */

/** @param {'pve.nodes'|'pve.guests'} operation @param {unknown} raw @returns {Resource[]} */
export function parseInventory(operation, raw) {
  if (operation !== 'pve.nodes' && operation !== 'pve.guests') return fail('schema');
  const data = envelope(raw).data;
  if (!Array.isArray(data) || data.length > 100) return fail('schema');
  /** @type {Map<string, Resource>} */
  const found = new Map();
  for (const unknownRow of data) {
    const row = object(unknownRow);
    const type = row.type;
    if (operation === 'pve.nodes' ? type !== 'node' : type !== 'qemu' && type !== 'lxc') return fail('schema');
    if (type !== 'node' && type !== 'qemu' && type !== 'lxc') return fail('schema');
    const node = text(row.node, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(node)) return fail('schema');
    const id = text(row.id, 128);
    const vmid = type === 'node' ? null : row.vmid;
    if (type !== 'node' && (typeof vmid !== 'number' || !Number.isSafeInteger(vmid) || vmid < 1)) return fail('schema');
    if (vmid !== null && typeof vmid !== 'number') return fail('schema');
    if (id !== (type === 'node' ? 'node/' + node : type + '/' + vmid)) return fail('schema');
    const templateValue = row.template ?? 0;
    if (templateValue !== 0 && templateValue !== 1) return fail('schema');
    const item = {
      id, type, node, vmid,
      label: row.name === undefined || row.name === '' ? (type === 'node' ? node : type.toUpperCase() + ' ' + vmid) : text(row.name, 200),
      platformState: row.status === undefined ? 'unknown' : text(row.status, 32),
      template: templateValue === 1,
    };
    const prior = found.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item)) return fail('schema');
    found.set(id, item);
  }
  return [...found.values()];
}

/** @param {Resource[]} resources */
export function toWire(resources) {
  return resources.map((item) => ({
    id: item.id, type: item.type, node: item.node,
    ...(item.vmid === null ? {} : { vmid: item.vmid }),
    name: item.label, status: item.platformState, template: item.template ? 1 : 0,
  }));
}
/** @typedef {{status: number, body: string}} ResponseEnvelope */
/** @param {unknown} input @returns {string} */
function body(input) {
  const value = object(input);
  if (value.status === 401 || value.status === 403) return fail('unauthorized');
  if (value.status !== 200) return fail('unavailable');
  if (typeof value.body !== 'string') return fail('schema');
  return value.body;
}

/**
 * Fixed operation plan; transport has no caller-controlled method, URL or headers.
 * @param {(operation: string) => Promise<ResponseEnvelope>} request
 * @param {(operation: 'pve.nodes'|'pve.guests', resources: Resource[]) => void} onBatch
 * @returns {Promise<string[]>}
 */
export async function runProxmox(request, onBatch) {
  try { parseVersion(body(await request('pve.version'))); }
  catch (error) { return [failure(error)]; }
  /** @type {string[]} */
  const failures = [];
  /** @type {('pve.nodes'|'pve.guests')[]} */
  const operations = ['pve.nodes', 'pve.guests'];
  for (const operation of operations) {
    try { onBatch(operation, parseInventory(operation, body(await request(operation)))); }
    catch (error) { failures.push(failure(error)); }
  }
  return failures;
}

/** No HTTP implementation is compiled or registered.
 * @param {string} scenario
 * @param {number} cycle
 */
export function mockTransport(scenario = 'normal', cycle = 0) {
  /** @type {string[]} */
  const calls = [];
  /** @param {unknown} data @returns {ResponseEnvelope} */
  const ok = (data) => ({ status: 200, body: JSON.stringify({ data }) });
  return {
    calls,
    /** @param {string} operation @returns {Promise<ResponseEnvelope>} */
    async request(operation) {
      if (!Object.hasOwn(PVE_OPERATIONS, operation)) return fail('unavailable');
      calls.push(operation);
      if (operation === 'pve.version') {
        if (scenario === 'version-denied') return { status: 403, body: 'PRIVATE RAW DIAGNOSTIC' };
        if (scenario === 'version-malformed') return ok({ version: '8.4.22', release: '9.2', repoid: '01234567' });
        return ok({ version: scenario === 'unsupported-version' ? '9.2.21' : '8.4.22', release: scenario === 'unsupported-version' ? '9.2' : '8.4', repoid: '01234567' });
      }
      if (operation === 'pve.nodes') return ok([
        { id: 'node/demo-a', type: 'node', node: 'demo-a', status: 'online' },
        { id: 'node/demo-b', type: 'node', node: 'demo-b', status: 'offline' },
      ]);
      if (scenario === 'partial-hang') { while (true) { /* Deliberate isolated-worker test fixture. */ } }
      if (scenario === 'guests-denied') return { status: 403, body: 'PRIVATE RAW DIAGNOSTIC' };
      if (scenario === 'guests-unavailable') return { status: 500, body: 'PRIVATE RAW DIAGNOSTIC' };
      if (scenario === 'guests-malformed') return ok([{ id: 'qemu/100', type: 'qemu', vmid: -100, node: 'demo-a' }]);
      if (scenario === 'empty-guests') return ok([]);
      return ok([
        { id: 'qemu/100', type: 'qemu', vmid: 100, node: cycle % 2 ? 'demo-b' : 'demo-a', name: 'Demo application VM', status: 'running' },
        { id: 'qemu/101', type: 'qemu', vmid: 101, node: 'demo-a', name: 'Demo paused VM', status: 'stopped' },
        { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'demo-b', name: 'Demo container', status: 'running' },
      ]);
    },
  };
}
