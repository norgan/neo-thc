import { parentPort, workerData } from 'node:worker_threads';
import { PROXMOX_TARGET, runProxmox, mockTransport, toWire } from './proxmox.mjs';

const port = parentPort;
if (!port) throw new Error('Worker channel unavailable');
/** @type {unknown} */
const input = workerData;
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid worker request');
const value = /** @type {Record<string, unknown>} */ (input);
const targets = ['fixture:gateway', 'fixture:nas', 'fixture:vm', 'fixture:unknown', 'fixture:old-lease', 'fixture:new-lease', PROXMOX_TARGET];
const scenarios = ['normal', 'cpu-hang', 'promise-hang', 'crash', 'early-exit', 'wrong-attempt', 'duplicate-batch', 'late-batch', 'partial-hang', 'version-denied', 'version-malformed', 'unsupported-version', 'guests-denied', 'guests-unavailable', 'guests-malformed', 'empty-guests'];
if (Object.keys(value).some((key) => !['v', 'attemptId', 'target', 'cycle', 'scenario'].includes(key)) ||
  value.v !== 1 || typeof value.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.attemptId) ||
  typeof value.target !== 'string' || !targets.includes(value.target) ||
  typeof value.cycle !== 'number' || !Number.isInteger(value.cycle) || value.cycle < 0 || value.cycle > 59 ||
  typeof value.scenario !== 'string' || !scenarios.includes(value.scenario)) throw new Error('Invalid worker request');
const request = { v: 1, attemptId: value.attemptId, target: value.target, cycle: value.cycle, scenario: value.scenario };
/** @param {Record<string, unknown>} message */
function send(message) {
  port?.postMessage(JSON.stringify({ v: 1, attemptId: request.attemptId, target: request.target, ...message }));
}
if (process.execArgv.length || Object.keys(process.env).length) {
  send({ type: 'done', failures: ['isolation'] });
} else if (request.scenario === 'crash') {
  throw new Error('PRIVATE RAW DIAGNOSTIC');
} else if (request.scenario === 'early-exit') {
  process.exit(0);
} else if (request.scenario === 'cpu-hang') {
  while (true) { /* Deliberate trusted fault fixture, terminated by the parent. */ }
} else if (request.scenario === 'promise-hang') {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
} else if (request.scenario === 'wrong-attempt') {
  port.postMessage(JSON.stringify({ v: 1, attemptId: 'wrong', target: request.target, type: 'batch', operation: 'fixture', records: [] }));
} else if (request.target === PROXMOX_TARGET) {
  const transport = mockTransport(request.scenario, request.cycle);
  const failures = await runProxmox(transport.request, (operation, resources) => {
    send({ type: 'batch', operation, records: toWire(resources) });
    if (request.scenario === 'duplicate-batch') send({ type: 'batch', operation, records: toWire(resources) });
  });
  send({ type: 'done', failures });
  if (request.scenario === 'late-batch') setTimeout(() => send({ type: 'batch', operation: 'pve.nodes', records: [] }), 20);
} else {
  send({ type: 'batch', operation: 'fixture', records: [{ target: request.target }] });
  if (request.scenario === 'duplicate-batch') send({ type: 'batch', operation: 'fixture', records: [{ target: request.target }] });
  send({ type: 'done', failures: [] });
}
