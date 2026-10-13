import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectorAdapter } from './collector.js';
import { JobManager, parseSubmission, RequestError } from './jobs.js';
import { DiscoveryCollector } from './discovery-runner.js';
import { localInterfaces, parseDiscovery, DISCOVERY_LIMITS } from './discovery-scope.js';
import type { DiscoveryInterface } from '../shared/types.js';
import { readDnsDefaults } from './discovery-defaults.js';
import { Store } from './store.js';

const allowedHosts = new Set(['127.0.0.1:4318', 'localhost:4318', '127.0.0.1:5173', 'localhost:5173']);
const allowedOrigins = new Set([...allowedHosts].map((host) => 'http://' + host));

export function createApp(options: { dbPath?: string; webRoot?: string; adapter?: CollectorAdapter; probeTimeoutMs?: number; discoveryAdapter?: CollectorAdapter; discoveryInterfaces?: () => DiscoveryInterface[]; testSupport?: boolean } = {}) {
  const store = new Store(options.dbPath, options.testSupport !== true);
  const discovery = options.discoveryAdapter ?? new DiscoveryCollector();
  const adapter = options.testSupport ? options.adapter ?? discovery : discovery;
  const jobs = new JobManager(store, adapter, options.probeTimeoutMs, discovery);
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
  app.get('/api/v1/health', async () => ({ status: jobs.problem ? 'degraded' : 'ok', synthetic: options.testSupport ? isSynthetic() : false, runtime: 'real-discovery-v2', collector: 'explicit-scope-discovery', collectionError: jobs.problem }));
  app.get('/api/v1/snapshot', async () => ({
    runtime: 'real-discovery-v2', synthetic: options.testSupport ? isSynthetic() : false,
    collectionError: jobs.problem, assets: store.assets(), jobs: store.jobs(), targets: options.testSupport ? adapter.targets : [],
  }));
  app.get('/api/v1/assets', async () => ({ synthetic: options.testSupport ? isSynthetic() : false, assets: store.assets() }));
  app.get<{ Params: { id: string } }>('/api/v1/assets/:id', async (request) => {
    const asset = store.assets().find((item) => item.id === request.params.id);
    if (!asset) throw new RequestError(404, 'Asset not found');
    return { synthetic: asset.latest?.synthetic !== false, asset, observations: store.observations(asset.id), observationLimit: 100 };
  });
  app.get('/api/v1/jobs', async () => ({ jobs: store.jobs() }));
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request) => {
    const job = store.job(request.params.id);
    if (!job) throw new RequestError(404, 'Job not found');
    return { job };
  });
  if (options.testSupport === true) app.post('/api/v1/jobs', async (request, reply) => {
    const { requestId, spec } = parseSubmission(request.body, adapter.targets.map((item) => item.key));
    const prior = store.jobByRequest(requestId);
    const job = jobs.start(requestId, spec);
    return reply.code(prior ? 200 : 202).send({ job });
  });
  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/cancel', async (request, reply) =>
    reply.code(202).send({ job: jobs.cancel(request.params.id) }));

  const interfaces = options.discoveryInterfaces ?? localInterfaces;
  app.get('/api/v1/discovery/options', async () => {
    const current=interfaces();
    return {interfaces:current, defaults:await readDnsDefaults(current), limits:DISCOVERY_LIMITS};
  });
  app.post('/api/v1/discovery/preview', async (request) => {
    const { plan } = parseDiscovery(request.body, interfaces());
    return { plan, maxDurationMs: 60000, warning: 'Network evidence does not establish device identity or health. Link-wide methods reach the entire selected interface subnet.' };
  });
  app.post('/api/v1/discovery/jobs', async (request, reply) => {
    const { requestId, spec } = parseDiscovery(request.body, interfaces(), true);
    const prior = store.jobByRequest(requestId);
    const job = jobs.start(requestId, spec);
    return reply.code(prior ? 200 : 202).send({ job });
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
  app.addHook('onClose', async () => { await jobs.shutdown(); store.close(); });
  return { app, store, jobs };
}
