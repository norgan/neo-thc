import { Buffer } from 'node:buffer';

export const MDNS_NAME = '_services._dns-sd._udp.local';
const browseName = Buffer.from([1, 2, ...Buffer.from('__MSBROWSE__'), 2, 1]);
export const NBNS_NAME = [...browseName].map((byte) => String.fromCharCode(65 + (byte >>> 4), 65 + (byte & 15))).join('');
/** @param {string} name */
function wireName(name) {
  return Buffer.concat([...name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])), Buffer.from([0])]);
}
/** @param {'mdns'|'nbns'} method @param {number} id */
export function discoveryQuery(method, id) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(method === 'nbns' ? 0x0010 : 0, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(method === 'nbns' ? 0x20 : 12, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, wireName(method === 'nbns' ? NBNS_NAME : MDNS_NAME), tail]);
}
/** @param {Buffer} packet @param {number} start */
export function readName(packet, start) {
  let cursor = start, end = -1, wireLength = 1, hops = 0;
  const visited = new Set();
  /** @type {string[]} */ const labels = [];
  while (true) {
    if (cursor >= packet.length || ++hops > 128 || visited.has(cursor)) throw new Error('packet');
    visited.add(cursor);
    const length = packet[cursor++];
    if (length === 0) { if (end < 0) end = cursor; break; }
    if ((length & 0xc0) === 0xc0) {
      if (cursor >= packet.length) throw new Error('packet');
      const pointer = ((length & 0x3f) << 8) | packet[cursor++];
      if (end < 0) end = cursor;
      if (pointer >= packet.length) throw new Error('packet');
      cursor = pointer;
      continue;
    }
    if (length > 63 || cursor + length > packet.length || (wireLength += length + 1) > 256) throw new Error('packet');
    const label = packet.subarray(cursor, cursor + length);
    if ([...label].some((byte) => byte < 33 || byte > 126 || byte === 46)) throw new Error('packet');
    labels.push(label.toString('ascii')); cursor += length;
  }
  return { name: labels.join('.').toLowerCase(), end };
}
/** @param {'mdns'|'nbns'} method @param {Buffer} packet @param {number} id */
export function parseAdvertisement(method, packet, id) {
  if (packet.length < 12 || packet.length > 8192 || packet.readUInt16BE(0) !== id) throw new Error('packet');
  const flags = packet.readUInt16BE(2);
  if (!(flags & 0x8000) || (flags & 0x780f) !== 0 || (flags & 0x0200)) throw new Error('packet');
  const counts = [4, 6, 8, 10].map((offset) => packet.readUInt16BE(offset));
  if (counts[0] > 1 || counts.slice(1).reduce((a, b) => a + b, 0) > 64) throw new Error('packet');
  const expected = (method === 'mdns' ? MDNS_NAME : NBNS_NAME).toLowerCase();
  const type = method === 'mdns' ? 12 : 0x20;
  let offset = 12;
  for (let i = 0; i < counts[0]; i++) {
    const name = readName(packet, offset); offset = name.end;
    if (offset + 4 > packet.length || name.name !== expected || packet.readUInt16BE(offset) !== type ||
      (packet.readUInt16BE(offset + 2) & 0x7fff) !== 1) throw new Error('packet');
    offset += 4;
  }
  if (method === 'mdns' && counts[0] !== 1) throw new Error('packet');
  /** @type {string[]} */ const claims = [];
  let ttlMs = 10000;
  for (let section = 1; section < 4; section++) {
    for (let index = 0; index < counts[section]; index++) {
      const owner = readName(packet, offset); offset = owner.end;
      if (offset + 10 > packet.length) throw new Error('packet');
      const rrType = packet.readUInt16BE(offset);
      const rrClass = packet.readUInt16BE(offset + 2) & 0x7fff;
      const ttl = packet.readUInt32BE(offset + 4);
      const length = packet.readUInt16BE(offset + 8);
      offset += 10;
      const end = offset + length;
      if (end > packet.length) throw new Error('packet');
      if (section === 1 && owner.name === expected && rrType === type && rrClass === 1 && ttl > 0) {
        if (method === 'mdns') {
          const target = readName(packet, offset);
          if (target.end !== end || !/^_[a-z0-9_-]+\._(?:tcp|udp)\.local$/.test(target.name)) throw new Error('packet');
          if (claims.length < 4 && !claims.includes(target.name)) claims.push(target.name);
          ttlMs = Math.min(ttlMs, ttl * 1000);
        } else {
          if (length < 6 || length % 6 !== 0 || length > 192) throw new Error('packet');
          // Returned NB address entries are intentionally never used as targets or identity.
          claims.push('Legacy NetBIOS browse-master response');
        }
      }
      offset = end;
    }
  }
  if (offset !== packet.length || !claims.length) throw new Error('packet');
  return { claims: [...new Set(claims)].slice(0, 4), ttlMs };
}

export const SSDP_QUERY = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: upnp:rootdevice\r\n\r\n','ascii');
/** @param {Buffer} packet */
export function parseSsdp(packet) {
  if (packet.length < 16 || packet.length > 8192) throw new Error('packet');
  const text = new TextDecoder('utf-8',{fatal:true}).decode(packet);
  if (!text.endsWith('\r\n\r\n')) throw new Error('packet');
  const lines = text.slice(0,-4).split('\r\n');
  if (lines.shift() !== 'HTTP/1.1 200 OK' || lines.length > 32) throw new Error('packet');
  const headers = new Map();
  for (const line of lines) {
    if (line.length > 512 || /[^\x20-\x7e\t]/.test(line)) throw new Error('packet');
    const split = line.indexOf(':');
    if (split < 1 || !/^[A-Za-z0-9-]+$/.test(line.slice(0,split))) throw new Error('packet');
    const key=line.slice(0,split).toLowerCase();
    if(headers.has(key)) throw new Error('packet');
    headers.set(key,line.slice(split+1).trim());
  }
  const usn=headers.get('usn');
  if(headers.get('st')!=='upnp:rootdevice' || typeof usn!=='string' ||
    !/^uuid:[A-Za-z0-9-]{8,80}(?:::upnp:rootdevice)?$/.test(usn)) throw new Error('packet');
  const expiry = /^max-age\s*=\s*([0-9]{1,10})$/i.exec(headers.get('cache-control') ?? '');
  if (!expiry || Number(expiry[1]) < 1) throw new Error('packet');
  // LOCATION and all other headers are intentionally dropped, never fetched or rendered.
  return {claims:[usn],ttlMs:Math.min(Number(expiry[1])*1000,10000)};
}
