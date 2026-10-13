import { createConnection, isIPv4 } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import { discoveryQuery, parseAdvertisement, SSDP_QUERY, parseSsdp } from './discovery-protocols.mjs';

/** @typedef {'open'|'closed'|'timeout'|'unreachable'|'error'} PortState */
/** @param {string} address @param {number} port @param {string} localAddress @param {AbortSignal} signal
 * @param {typeof createConnection} connect */
export function tcpProbe(address, port, localAddress, signal, connect = createConnection) {
  /** @returns {Promise<PortState>} */
  const run = () => new Promise((resolve) => {
    if (signal.aborted) { resolve('error'); return; }
    const socket = connect({ host: address, port, family: 4, localAddress });
    let settled = false;
    /** @param {PortState} value */
    const finish = (value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const cleanup = setTimeout(() => resolve('error'), 100);
      socket.once('close', () => { clearTimeout(cleanup); resolve(value); });
      socket.destroy();
    };
    const abort = () => finish('error');
    const timer = setTimeout(() => finish('timeout'), 400);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => {
      const code = 'code' in error ? error.code : '';
      finish(code === 'ECONNREFUSED' ? 'closed' : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'unreachable' : 'error');
    });
    // No application bytes, banner reads or protocol handshakes.
  });
  return run();
}
/** @param {string} address @param {string} server @param {string} localAddress @param {AbortSignal} signal
 * @param {() => Resolver} createResolver */
export async function ptrProbe(address, server, localAddress, signal, createResolver = () => new Resolver({ timeout: 500, tries: 1 })) {
  const resolver = createResolver();
  resolver.setLocalAddress(localAddress);
  resolver.setServers([server]);
  const abort = () => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 600);
  try {
    if (signal.aborted) return { state: 'error', names: [] };
    const names = await resolver.reverse(address);
    return { state: 'answer', names: names.filter((name) => /^[a-zA-Z0-9._-]{1,253}$/.test(name)).slice(0, 4) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return { state: code === 'ENOTFOUND' || code === 'ENODATA' ? 'no_data' : 'error', names: [] };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); resolver.cancel();
  }
}
/**
 * @param {'mdns'|'nbns'|'ssdp'} method
 * @param {import('../shared/types.js').DiscoveryPlan} plan
 * @param {AbortSignal} signal
 * @param {typeof createSocket} socketFactory
 * @returns {Promise<{found: Map<string, {claims:string[], ttlMs:number}>, sent:number, received:number, capped:boolean, failed:boolean}>}
 */
export function advertise(method, plan, signal, socketFactory = createSocket) {
  /** @type {Map<string, {claims: string[], ttlMs: number}>} */ const found = new Map();
  return new Promise((resolve) => {
    const socket = socketFactory('udp4');
    let closed = false, received = 0, sent = 0, capped = false, failed = false;
    const id = randomInt(65536);
    const allowed = new Set(plan.targets);
    const finish = () => {
      if (closed) return; closed = true;
      clearTimeout(timer); signal.removeEventListener('abort', finish);
      try { socket.close(); } catch { /* Not bound yet. */ }
      resolve({ found, sent, received, capped, failed });
    };
    const timer = setTimeout(finish, 2000);
    signal.addEventListener('abort', finish, { once: true });
    socket.on('error', () => { failed = true; finish(); });
    socket.on('message', (packet, sender) => {
      if (closed) return;
      received++;
      if (received >= 256) { capped = true; finish(); return; }
      if (packet.length > 8192 || sender.port !== (method === 'mdns' ? 5353 : method === 'ssdp' ? 1900 : 137) ||
        !allowed.has(sender.address) || found.has(sender.address)) return;
      try { found.set(sender.address, method === 'ssdp' ? parseSsdp(packet) : parseAdvertisement(method, packet, id)); } catch { /* Untrusted malformed replies are ignored. */ }
    });
    socket.bind(0, plan.interface.address, () => {
      if (closed) { try { socket.close(); } catch {} return; }
      if (signal.aborted) { finish(); return; }
      try {
        socket.setTTL(method === 'mdns' ? 255 : 1);
        let destination = '224.0.0.251';
        if (method === 'mdns' || method === 'ssdp') {
          if (method === 'ssdp') destination = '239.255.255.250';
          socket.setMulticastInterface(plan.interface.address); socket.setMulticastTTL(method === 'mdns' ? 255 : 1);
        } else {
          socket.setBroadcast(true);
          const parts = plan.interface.address.split('.').map(Number);
          const mask = plan.interface.netmask.split('.').map(Number);
          destination = parts.map((part, index) => part | (255 ^ mask[index])).join('.');
        }
        if (!isIPv4(destination)) throw new Error('destination');
        socket.send(method === 'ssdp' ? SSDP_QUERY : discoveryQuery(method, id), method === 'mdns' ? 5353 : method === 'ssdp' ? 1900 : 137, destination, (error) => {
          if (error) { failed = true; finish(); } else sent++;
        });
      } catch { failed = true; finish(); }
    });
    if (signal.aborted) finish();
  });
}
/** @template T @param {T[]} values @param {number} concurrency @param {(value:T) => Promise<void>} action */
export async function pool(values, concurrency, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) await action(values[next++]);
  }));
}
