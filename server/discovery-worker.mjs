import { parentPort, workerData } from 'node:worker_threads';
import { tcpProbe, ptrProbe, advertise, pool, createPacer } from './discovery-network.mjs';
import { validateWirePlan } from './discovery-result.mjs';
const port = parentPort;
if (!port) throw new Error('worker');
/** @type {unknown} */ const input = workerData;
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('worker');
const request = /** @type {Record<string,unknown>} */ (input);
if (Object.keys(request).some((key) => !['v','attemptId','plan'].includes(key)) || request.v !== 1 ||
  typeof request.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.attemptId) ||
  process.execArgv.length || Object.keys(process.env).length) throw new Error('worker');
const plan = validateWirePlan(request.plan);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Math.max(1000,(plan.maxDurationMs??60000)-(plan.glances?23000:2000)));
/** @param {Record<string,unknown>} message */
const send = (message) => port.postMessage(JSON.stringify({ v:1, attemptId:request.attemptId, ...message }));
const progress = { addressesCompleted:0, totalAddresses:plan.targets.length, tcpCompleted:0, dnsCompleted:0, datagramsSent:0 };
/** @type {string[]} */ const failures = [];
const startedAt=Date.now();
/** @type {Map<import('../shared/types.js').DiscoveryMethod,import('../shared/types.js').DiscoveryOutcome>} */
const outcomes=new Map(plan.methods.map((method)=>[method,{method,attempted:0,completed:0,responses:0,durationMs:0,issues:[]} ]));
/** @type {Map<string, {claims:string[],ttlMs:number}>} */ let mdns = new Map();
/** @type {Map<string, {claims:string[],ttlMs:number}>} */ let nbns = new Map();
/** @type {Map<string, {claims:string[],ttlMs:number}>} */ let ssdp = new Map();
try {
  await Promise.all((['mdns','nbns','ssdp']).map(async (method) => {
    if ((method !== 'mdns' && method !== 'nbns' && method !== 'ssdp') || !plan.methods.includes(method)) return;
    const started=Date.now(), outcome=outcomes.get(method);
    if(!outcome)throw new Error('method');
    outcome.attempted=1;
    const result = await advertise(method, plan, controller.signal);
    outcome.completed=1;outcome.responses=result.found.size;outcome.durationMs=Date.now()-started;
    if(result.capped)outcome.issues.push('response_cap');
    if(result.issue)outcome.issues.push(result.issue);
    progress.datagramsSent += result.sent;
    if (method === 'mdns') mdns = result.found; else if(method === 'ssdp') ssdp = result.found; else nbns = result.found;
    if (result.capped) failures.push('packet_cap');
    if (result.failed) failures.push('socket_error');
  }));
  const states = new Map(plan.targets.map((address) => [address, {
    address, ports: /** @type {{port:number,state:string}[]} */ ([]),
    dns:{ state:'not_requested', names: /** @type {string[]} */ ([]) },
    mdns:mdns.get(address)?.claims ?? [], nbns:nbns.has(address), ssdp:ssdp.get(address)?.claims.slice(0,1) ?? [],
    ttlMs:Math.min(mdns.get(address)?.ttlMs ?? 60000, ssdp.get(address)?.ttlMs ?? 60000),
    remaining:plan.ports.length + Number(plan.methods.includes('ptr')),
  }]));
  /** @param {string} address */
  const emit = (address) => {
    const state = states.get(address);
    if (!state || state.remaining !== 0 || controller.signal.aborted) return;
    state.remaining = -1;
    const { remaining, ...result } = state;
    send({ type:'batch', result });
    progress.addressesCompleted++;
    send({ type:'progress', progress:{...progress} });
  };
  for (const address of plan.targets) emit(address);
  const pace=createPacer(controller.signal);
  await Promise.all([
    pool(plan.targets.flatMap((address) => plan.ports.map((port) => ({address,port}))), plan.tcpConcurrency??16, async ({address,port}) => {
      if (controller.signal.aborted) return;
      const state = states.get(address);
      if (!state) return;
      const outcome=outcomes.get('tcp');if(!outcome)throw new Error('method');outcome.attempted++;
      await pace();if(controller.signal.aborted)return;
      const result = await tcpProbe(address, port, plan.interface.address, controller.signal, undefined, (issue)=>{if(!outcome.issues.includes(issue))outcome.issues.push(issue);});
      outcome.completed++;outcome.responses+=Number(result==='open'||result==='closed');outcome.durationMs=Date.now()-startedAt;
      if (result === 'error' && !failures.includes('tcp_error')) failures.push('tcp_error');
      state.ports.push({port,state:result}); state.remaining--; progress.tcpCompleted++; emit(address);
    }),
    pool(plan.methods.includes('ptr') ? plan.targets : [], 8, async (address) => {
      if (controller.signal.aborted) return;
      const state = states.get(address);
      if (!state || !plan.resolver) throw new Error('resolver');
      const outcome=outcomes.get('ptr');if(!outcome)throw new Error('method');outcome.attempted++;
      const dns=await ptrProbe(address, plan.resolver, plan.interface.address, controller.signal);
      state.dns={state:dns.state,names:dns.names};
      outcome.completed++;outcome.responses+=Number(dns.state==='answer'||dns.state==='no_data');outcome.durationMs=Date.now()-startedAt;
      if(dns.issue&&!outcome.issues.includes(dns.issue))outcome.issues.push(dns.issue);
      if (state.dns.state === 'error' && !failures.includes('dns_error')) failures.push('dns_error');
      state.remaining--; progress.dnsCompleted++; emit(address);
    }),
  ]);
  if (controller.signal.aborted) failures.push('deadline');
  send({ type:'done', failures:[...new Set(failures)], outcomes:[...outcomes.values()] });
} catch { send({ type:'done', failures:['collector_error'], outcomes:[...outcomes.values()] }); }
finally { clearTimeout(timer); }
