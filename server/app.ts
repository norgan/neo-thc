import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectorAdapter } from './collector.js';
import { JobManager, parseSubmission, RequestError } from './jobs.js';
import { DiscoveryCollector } from './discovery-runner.js';
import { localInterfaces, parseDiscovery, DISCOVERY_LIMITS } from './discovery-scope.js';
import type { DiscoveryInterface } from '../shared/types.js';
import { readDnsDefaults } from './discovery-defaults.js';
import { systemViews } from '../shared/inventory.js';
import { GLANCES_PATHS, resolveGlancesTarget, readGlances, glancesRequest } from './glances.js';
import {GlancesEnricher,createGlancesWorker} from './glances-enrichment.js';
import { Store } from './store.js';
import {DiagnosticRunner,parseDiagnostic,type createDiagnosticWorker} from './diagnostics.js';
import {diagnosticOptions,benchmarkResolverProblem} from './diagnostic-options.js';
import {InternetRunner,type InternetProbes} from './internet-runner.js';
import {internetOperations,INTERNET_DURATION_MS} from '../shared/internet.js';
import {accessProblem,type AccessPolicy} from './access.js';
import {parsePlayback} from '../shared/playback.js';
import {deviceEvidence} from './device.js';
import {DnsBenchmarkRunner} from './dns-benchmark-runner.js';
import {dnsBenchmarkPreview,parseDnsBenchmark,PUBLIC_DNS_BENCHMARK_RESOLVERS} from './dns-benchmark.js';
import {DNS_BENCHMARK_LIMITS} from '../shared/dns-benchmark.js';

const allowedHosts = new Set(['127.0.0.1:4318', 'localhost:4318', '127.0.0.1:5173', 'localhost:5173']);
const allowedOrigins = new Set([...allowedHosts].map((host) => 'http://' + host));

export function createApp(options: { dbPath?: string; webRoot?: string; access?:AccessPolicy; tls?:{key:Buffer;cert:Buffer}; deviceVantage?:'this-computer'|'collector'; adapter?: CollectorAdapter; probeTimeoutMs?: number; discoveryAdapter?: CollectorAdapter; discoveryInterfaces?: () => DiscoveryInterface[]; testSupport?: boolean; glancesRead?: typeof glancesRequest; glancesWorkerFactory?: typeof createGlancesWorker; diagnosticWorkerFactory?:typeof createDiagnosticWorker; internetProbes?:InternetProbes; readDiagnosticOptions?:typeof diagnosticOptions; dnsBenchmarkRunner?:Pick<DnsBenchmarkRunner,'problem'|'run'|'capability'> } = {}) {
  if(options.access?.mode==='service'&&!options.tls)throw new Error('Service mode requires TLS');
  const store = new Store(options.dbPath, options.testSupport !== true);
  const discovery = options.discoveryAdapter ?? new DiscoveryCollector();
  const adapter = options.testSupport ? options.adapter ?? discovery : discovery;
  const interfaces = options.discoveryInterfaces ?? localInterfaces;
  const enrichment = new GlancesEnricher(store,interfaces,options.glancesWorkerFactory,options.glancesRead);
  const dnsBenchmark=options.dnsBenchmarkRunner??new DnsBenchmarkRunner();
  const jobs = new JobManager(store, adapter, options.probeTimeoutMs, discovery,enrichment,new DiagnosticRunner(options.diagnosticWorkerFactory,new InternetRunner(options.internetProbes)),dnsBenchmark);
  let statsActive: {requestId:string;controller:AbortController;done:Promise<unknown>}|null=null;
  let statsProblem:string|null=null;
  const configReads=new Set<{controller:AbortController;done:Promise<unknown>}>();
  const collectionProblem=()=>jobs.problem??statsProblem;
  // Unused browser preconnections and incomplete requests must not hold shutdown open.
  const app = Fastify({ ...(options.tls?{https:options.tls}:{}), logger: false, bodyLimit: 8_192, requestTimeout: 10_000, trustProxy: false, forceCloseConnections: true });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const accessError=accessProblem(options.access??{mode:'local'},request.headers.host,request.headers.origin,request.headers.authorization);
    if(accessError)throw new RequestError(accessError==='Authentication required'?401:403,accessError);
    const origin = request.headers.origin;
    if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-neo-client'] !== 'local-ui') {
      throw new RequestError(403, 'A local client header is required');
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode : undefined;
    const code = error instanceof RequestError ? error.statusCode
      : typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
    reply.code(code).send({ error: error instanceof RequestError ? error.message
      : code < 500 ? 'Invalid request' : 'Request failed. No diagnostic details are exposed.' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));

  const isSynthetic = () => !store.jobs().some((job) => !!job.spec.discovery) && store.assets().every((asset) => asset.latest?.synthetic !== false);
  app.get('/api/v1/health', async () => ({ status: collectionProblem() ? 'degraded' : 'ok', synthetic: options.testSupport ? isSynthetic() : false, runtime: 'playback-desktop-v7', collector: 'explicit-scope-discovery', collectionError: collectionProblem() }));
  app.get('/api/v1/placement',async()=>({mode:options.access?.mode==='service'?'service':'local',collector:'This collector computer',deviceChecks:options.deviceVantage??'collector'}));
  app.get('/api/v1/playback',async()=>({reports:store.playback()}));
  app.post('/api/v1/playback',{bodyLimit:65536},async(request,reply)=>{
    let capture;try{capture=parsePlayback(request.body);}catch(error){throw new RequestError(400,error instanceof Error?error.message:'Invalid playback report');}
    if(store.playback().length>=200)throw new RequestError(409,'Playback history is full. Existing reports are retained.');
    return reply.code(201).send({report:store.savePlayback(capture)});
  });
  app.post('/api/v1/local-device',async()=>{
    if(configReads.size>=4)throw new RequestError(409,'A local configuration read is already active.');
    const controller=new AbortController();const read={controller,done:deviceEvidence(controller.signal,options.deviceVantage??'collector')};configReads.add(read);
    try{return await read.done;}finally{configReads.delete(read);}
  });
  app.get('/api/v1/snapshot', async () => ({
    runtime: 'playback-desktop-v7', synthetic: options.testSupport ? isSynthetic() : false,
    collectionError: collectionProblem(), assets: store.assets(), systems:systemViews(store.assets()), stats:store.stats(), statsActive:statsActive?.requestId??null, jobs: store.jobs(), targets: options.testSupport ? adapter.targets : [],
  }));
  app.get('/api/v1/assets', async () => ({ synthetic: options.testSupport ? isSynthetic() : false, assets: store.assets() }));
  app.get<{ Params: { id: string } }>('/api/v1/assets/:id', async (request) => {
    const asset = store.assets().find((item) => item.id === request.params.id);
    if (!asset) throw new RequestError(404, 'Asset not found');
    const system=systemViews(store.assets()).find((view)=>view.assetIds.includes(asset.id));
    const observations=(system?.assetIds??[asset.id]).flatMap((id)=>store.observations(id)).sort((left,right)=>right.observedAt-left.observedAt).slice(0,100);
    return { synthetic: asset.latest?.synthetic !== false, asset, system, observations, stats:store.stats().filter((item)=>system?.assetIds.includes(item.assetId)), observationLimit: 100 };
  });
  app.get('/api/v1/jobs', async () => ({ jobs: store.jobs() }));
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request) => {
    const job = store.job(request.params.id);
    if (!job) throw new RequestError(404, 'Job not found');
    return { job };
  });
  if (options.testSupport === true) app.post('/api/v1/jobs', async (request, reply) => {
    if(statsActive||statsProblem)throw new RequestError(409,'A stats read is active or unavailable. Finish it before discovery.');
    const { requestId, spec } = parseSubmission(request.body, adapter.targets.map((item) => item.key));
    const prior = store.jobByRequest(requestId);
    const job = jobs.start(requestId, spec);
    return reply.code(prior ? 200 : 202).send({ job });
  });
  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/cancel', async (request, reply) =>
    reply.code(202).send({ job: jobs.cancel(request.params.id) }));

  app.get('/api/v1/discovery/options', async () => {
    const current=interfaces();
    return {interfaces:current, defaults:await readDnsDefaults(current), limits:DISCOVERY_LIMITS};
  });
  app.post('/api/v1/discovery/preview', async (request) => {
    const { plan } = parseDiscovery(request.body, interfaces());
    return { plan, maxDurationMs: plan.maxDurationMs??60000, warning: 'Network evidence does not establish device identity or health. Link-wide methods reach the entire selected interface subnet.' };
  });
  app.post('/api/v1/discovery/jobs', async (request, reply) => {
    if(statsActive||statsProblem)throw new RequestError(409,'A stats read is active or unavailable. Finish it before discovery.');
    const { requestId, spec } = parseDiscovery(request.body, interfaces(), true);
    const prior = store.jobByRequest(requestId);
    const job = jobs.start(requestId, spec);
    return reply.code(prior ? 200 : 202).send({ job });
  });

  app.get('/api/v1/diagnostics/options',async(_request,reply)=>{
    const controller=new AbortController(),read={controller,done:(options.readDiagnosticOptions??diagnosticOptions)(controller.signal)};
    const abort=()=>controller.abort();configReads.add(read);reply.raw.once('close',abort);
    try{return await read.done;}finally{reply.raw.removeListener('close',abort);configReads.delete(read);}
  });
  app.post('/api/v1/diagnostics/preview',async(request)=>{
    const {plan}=parseDiagnostic(request.body,store);
    return {plan,maxDurationMs:plan.kind==='internet'?INTERNET_DURATION_MS:12000,operations:plan.kind==='internet'?internetOperations(plan):plan.kind==='dns'?plan.resolvers.length*2+(plan.systemLookup?1:0):plan.addresses.length};
  });
  app.post('/api/v1/diagnostics/jobs',async(request,reply)=>{
    if(statsActive||statsProblem)throw new RequestError(409,'A stats read is active or unavailable. Finish it before diagnostics.');
    const {requestId,spec}=parseDiagnostic(request.body,store,true),prior=store.jobByRequest(requestId);
    return reply.code(prior?200:202).send({job:jobs.start(requestId,spec)});
  });

  app.get('/api/v1/dns-benchmark/options',async(_request,reply)=>{
    if(configReads.size>=4)throw new RequestError(409,'A configuration read is already active. Try again shortly.');
    const controller=new AbortController();
    const done=Promise.all([(options.readDiagnosticOptions??diagnosticOptions)(controller.signal),dnsBenchmark.capability(controller.signal)]);
    const read={controller,done},abort=()=>controller.abort();configReads.add(read);reply.raw.once('close',abort);
    try{
      const [configuration,capability]=await done;
      const resolvers=configuration.resolvers.map(({reason:_priorReason,...row})=>{
        const reason=benchmarkResolverProblem(row.address);return {...row,supported:reason===null,...(reason?{reason}:{})};
      });
      return {source:configuration.source,resolvers,capability,publicResolvers:PUBLIC_DNS_BENCHMARK_RESOLVERS,limits:DNS_BENCHMARK_LIMITS};
    }finally{reply.raw.removeListener('close',abort);configReads.delete(read);}
  });
  app.post('/api/v1/dns-benchmark/preview',async(request)=>dnsBenchmarkPreview(parseDnsBenchmark(request.body).plan));
  app.post('/api/v1/dns-benchmark/jobs',async(request,reply)=>{
    if(statsActive||statsProblem)throw new RequestError(409,'A stats read is active or unavailable. Finish it before benchmarking DNS.');
    const {requestId,spec}=parseDnsBenchmark(request.body,true),prior=store.jobByRequest(requestId);
    // Keep replay idempotent, including after the executable has moved or been removed.
    if(prior)return reply.code(200).send({job:jobs.start(requestId,spec)});
    if(configReads.size>=4)throw new RequestError(409,'A configuration read is already active. Try again shortly.');
    const controller=new AbortController(),read={controller,done:dnsBenchmark.capability(controller.signal)};
    const abort=()=>controller.abort();configReads.add(read);reply.raw.once('close',abort);
    let capability;
    try{capability=await read.done;}finally{reply.raw.removeListener('close',abort);configReads.delete(read);}
    if(!capability.available)throw new RequestError(503,capability.reason??'DNS benchmark tool is unavailable on this collector.');
    return reply.code(202).send({job:jobs.start(requestId,spec)});
  });

  app.post<{Params:{id:string}}>('/api/v1/assets/:id/glances/preview',async(request)=>{
    const target=resolveGlancesTarget(store,request.params.id,request.body,false,interfaces());
    return {endpoint:target.scheme+'://'+target.address+':'+target.port,sourceAddress:target.sourceAddress,
      paths:GLANCES_PATHS,maxRequests:6,timeoutMs:12000,credentials:false};
  });
  app.post<{Params:{id:string}}>('/api/v1/assets/:id/glances/read',async(request,reply)=>{
    const target=resolveGlancesTarget(store,request.params.id,request.body,true,interfaces());
    const prior=store.statsByRequest(target.requestId);
    if(prior) {
      if(prior.assetId!==target.assetId||prior.endpoint!==target.scheme+'://'+target.address+':'+target.port)throw new RequestError(409,'requestId belongs to another stats endpoint.');
      return {snapshot:prior};
    }
    if(jobs.busy||statsActive||collectionProblem())throw new RequestError(409,'Another collection is active or unavailable.');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    reply.raw.once('close',disconnected);
    const done=readGlances(target,controller.signal,options.glancesRead??glancesRequest);
    statsActive={requestId:target.requestId,controller,done};
    try {
      const snapshot=await done;
      if(snapshot.issues.some((issue)=>issue.code==='cleanup_failed'))statsProblem='A stats socket did not close. Restart Neo before further collection.';
      try {store.saveStats(snapshot);} catch {statsProblem='Stats storage is unavailable or full. Restart after resolving local storage before further collection.';throw new RequestError(503,statsProblem);}
      return {snapshot};
    } finally {clearTimeout(timeout);reply.raw.removeListener('close',disconnected);statsActive=null;}
  });
  app.post<{Params:{id:string}}>('/api/v1/stats/:id/cancel',async(request)=>{
    if(statsActive?.requestId===request.params.id)statsActive.controller.abort();
    return {cancelRequested:true};
  });

  if (options.webRoot) {
    const root = options.webRoot;
    app.get('/companion.zip',async(_request,reply)=>reply.type('application/zip').header('Content-Disposition','attachment; filename="neo-playback-companion.zip"').send(await readFile(join(root,'companion.zip'))));
    app.get('/playback-guide',async(_request,reply)=>reply.type('text/html; charset=utf-8').send(await readFile(join(root,'playback-guide.html'))));
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(join(root, 'index.html'))));
    app.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
      const file = request.params.file;
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(file)) throw new RequestError(404, 'Not found');
      const content = await readFile(join(root, 'assets', file)).catch(() => null);
      if (!content) throw new RequestError(404, 'Not found');
      return reply.type(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8').send(content);
    });
  }
  app.addHook('preClose', async () => {
    // onClose runs after HTTP requests drain, so cancel work here while its response is still pending.
    const stats = statsActive;
    stats?.controller.abort();
    for(const read of configReads)read.controller.abort();
    await Promise.all([stats?.done, jobs.shutdown(),Promise.allSettled([...configReads].map((read)=>read.done))]);
  });
  app.addHook('onClose', async () => { store.close(); });
  return { app, store, jobs };
}
