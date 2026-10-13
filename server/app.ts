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

const allowedHosts = new Set(['127.0.0.1:4318', 'localhost:4318', '127.0.0.1:5173', 'localhost:5173']);
const allowedOrigins = new Set([...allowedHosts].map((host) => 'http://' + host));

export function createApp(options: { dbPath?: string; webRoot?: string; adapter?: CollectorAdapter; probeTimeoutMs?: number; discoveryAdapter?: CollectorAdapter; discoveryInterfaces?: () => DiscoveryInterface[]; testSupport?: boolean; glancesRead?: typeof glancesRequest; glancesWorkerFactory?: typeof createGlancesWorker } = {}) {
  const store = new Store(options.dbPath, options.testSupport !== true);
  const discovery = options.discoveryAdapter ?? new DiscoveryCollector();
  const adapter = options.testSupport ? options.adapter ?? discovery : discovery;
  const interfaces = options.discoveryInterfaces ?? localInterfaces;
  const enrichment = new GlancesEnricher(store,interfaces,options.glancesWorkerFactory,options.glancesRead);
  const jobs = new JobManager(store, adapter, options.probeTimeoutMs, discovery,enrichment);
  let statsActive: {requestId:string;controller:AbortController;done:Promise<unknown>}|null=null;
  let statsProblem:string|null=null;
  const collectionProblem=()=>jobs.problem??statsProblem;
  const app = Fastify({ logger: false, bodyLimit: 8_192, requestTimeout: 10_000, trustProxy: false });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedHosts.has(request.headers.host ?? '')) throw new RequestError(403, 'Unrecognized local host');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new RequestError(403, 'Cross-origin access is unavailable');
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
  app.get('/api/v1/health', async () => ({ status: collectionProblem() ? 'degraded' : 'ok', synthetic: options.testSupport ? isSynthetic() : false, runtime: 'network-overview-v4', collector: 'explicit-scope-discovery', collectionError: collectionProblem() }));
  app.get('/api/v1/snapshot', async () => ({
    runtime: 'network-overview-v4', synthetic: options.testSupport ? isSynthetic() : false,
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
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(join(root, 'index.html'))));
    app.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
      const file = request.params.file;
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(file)) throw new RequestError(404, 'Not found');
      const content = await readFile(join(root, 'assets', file)).catch(() => null);
      if (!content) throw new RequestError(404, 'Not found');
      return reply.type(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8').send(content);
    });
  }
  app.addHook('onClose', async () => { statsActive?.controller.abort();await statsActive?.done;await jobs.shutdown(); store.close(); });
  return { app, store, jobs };
}
