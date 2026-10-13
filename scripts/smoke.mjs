import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'linux', 'This bounded process-group smoke check targets the Linux CI runner');
const base = 'http://127.0.0.1:4318';
const directory = await mkdtemp(join(tmpdir(), 'neo-smoke-'));
const controller = new AbortController();
let server;
let exited = false;
let exitCode = null;
let exitSignal = null;
let log = '';
let failed = false;
const timeout = setTimeout(() => controller.abort(new Error('Smoke check exceeded 30 seconds')), 30_000);

async function api(path, options = {}) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Only local paths are allowed');
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_500)]),
    headers: { 'Content-Type': 'application/json', 'X-Neo-Client': 'local-ui', ...options.headers },
  });
  assert.ok(response.ok, 'Unexpected HTTP ' + response.status + ' at ' + path);
  return response;
}

async function until(check, budgetMs, message) {
  const stop = Date.now() + budgetMs;
  while (Date.now() < stop) {
    controller.signal.throwIfAborted();
    if (await check()) return;
    await delay(50, undefined, { signal: controller.signal });
  }
  throw new Error(message);
}

function signalGroup(signal) {
  if (!server?.pid) return;
  try { process.kill(-server.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function groupExists() {
  if (!server?.pid) return false;
  try { process.kill(-server.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function portIsClosed() {
  return fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(500) })
    .then(() => false, () => true);
}

try {
  await access('dist/server/server/discovery-worker.mjs');
  // Execute the actual compiled discovery worker against one isolated loopback TCP listener.
  // No production API scope override, mock worker, LAN multicast or broadcast is used.
  const listener=createServer((socket)=>socket.on('data',()=>assert.fail('Unexpected probe payload')));
  await new Promise((resolve)=>listener.listen(0,'127.0.0.1',resolve));
  const listenAddress=listener.address();
  const loopbackPlan={interface:{id:'isolated-loopback',name:'CI loopback',address:'127.0.0.1',netmask:'255.0.0.0',cidr:'127.0.0.0/8'},
    cidr:'127.0.0.1/32',targets:['127.0.0.1'],methods:['tcp'],ports:[listenAddress.port],resolver:null,linkScopeConfirmed:false,tcpBudget:1,dnsBudget:0,datagramBudget:0};
  const worker=new Worker(new URL('../dist/server/server/discovery-worker.mjs',import.meta.url),{
    workerData:{v:1,attemptId:randomUUID(),plan:loopbackPlan},execArgv:[],env:{},stdout:true,stderr:true,
  });
  worker.stdout.resume();worker.stderr.resume();
  const batches=[];
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Compiled discovery worker deadline')),5000);
      worker.once('error',(error)=>{clearTimeout(timer);reject(error);});
      worker.on('message',(raw)=>{
        const message=JSON.parse(raw);
        if(message.type==='batch')batches.push(message.result);
        if(message.type==='done'){clearTimeout(timer);try{assert.deepEqual(message.failures,[]);assert.equal(message.outcomes[0].responses,1);resolve();}catch(error){reject(error);}}
      });
    });
  } finally {await worker.terminate();await new Promise((resolve)=>listener.close(resolve));}
  assert.equal(batches.length,1);assert.equal(batches[0].ports[0].state,'open');
  // Actual compiled read-only HTTP transport, isolated loopback endpoint and synthetic payload only.
  const {readGlances,GLANCES_PATHS}=await import('../dist/server/server/glances.js');
  const paths=[];
  const metrics={'/api/4/version':'4.5.8','/api/4/system':{hostname:'ci.example',os_name:'Test OS'},
    '/api/4/cpu':{total:0},'/api/4/mem':{percent:25,total:1024,available:768},'/api/4/fs':[],'/api/4/uptime':'1 hour'};
  const statsServer=createHttpServer((request,response)=>{paths.push(request.url);response.setHeader('Content-Type','application/json');response.end(JSON.stringify(metrics[request.url]));});
  await new Promise((resolve)=>statsServer.listen(0,'127.0.0.1',resolve));
  try {
    const stats=await readGlances({assetId:'compiled-smoke',requestId:'compiled-stats-smoke',address:'127.0.0.1',sourceAddress:'127.0.0.1',scheme:'http',port:statsServer.address().port},controller.signal);
    assert.equal(stats.status,'complete');assert.equal(stats.cpuPercent,0);assert.deepEqual(stats.filesystems,[]);assert.deepEqual(paths,[...GLANCES_PATHS]);
  } finally {statsServer.closeAllConnections();await new Promise((resolve)=>statsServer.close(resolve));}
  const {Store}=await import('../dist/server/server/store.js');
  const {discoveryObservation}=await import('../dist/server/server/discovery-runner.js');
  const evidence=discoveryObservation(batches[0],loopbackPlan,'actual-loopback-smoke');
  const seed=new Store(join(directory,'neo.sqlite'));
  seed.ingest([evidence,{...evidence,id:randomUUID(),source:'fixture-v1',synthetic:true,subjectKey:'old-demo',label:'Hidden legacy sample'}]);seed.close();
  assert.ok(await portIsClosed(), 'Port 4318 must be unused before this smoke check');
  server = spawn('npm', ['start'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEO_DB_PATH: join(directory, 'neo.sqlite') },
  });
  const record = (chunk) => { log = (log + chunk.toString()).slice(-16_000); };
  server.stdout.on('data', record);
  server.stderr.on('data', record);
  server.once('error', () => { exited = true; exitCode = 1; });
  server.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

  await until(async () => {
    if (exited) throw new Error('npm start exited before readiness');
    try {
      const response = await api('/api/v1/health');
      const health = await response.json();
      return health.status === 'ok' && health.synthetic === false && health.runtime === 'semantic-inventory-v3';
    } catch { return false; }
  }, 10_000, 'Compiled server never became ready');

  const page = await api('/');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /Neo THC/);
  const javascript = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const stylesheet = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  assert.ok(javascript, 'Built HTML must reference the compiled JavaScript');
  assert.ok(stylesheet, 'Built HTML must reference the compiled CSS');
  for (const [path, type] of [[javascript, 'javascript'], [stylesheet, 'text/css']]) {
    const asset = await api(path);
    assert.ok((asset.headers.get('content-type') ?? '').includes(type), 'Correct asset MIME type');
    assert.ok((await asset.text()).length > 100, 'Built asset must not be empty');
  }

  const inventory=await (await api('/api/v1/assets')).json();
  assert.equal(inventory.assets.length,1);
  assert.equal(inventory.assets[0].latest.synthetic,false);
  assert.deepEqual(inventory.assets[0].identityWarnings,[]);
  assert.equal(inventory.assets[0].latest.services[0].note.includes('open'),true);
  const snapshot=await (await api('/api/v1/snapshot')).json();
  assert.equal(snapshot.systems.length,1);assert.equal(snapshot.systems[0].responded,true);
  assert.equal(snapshot.runtime,'semantic-inventory-v3');assert.deepEqual(snapshot.targets,[]);
  const removed=await fetch(base+'/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'},
    body:JSON.stringify({requestId:'no-runtime-fixture',mode:'initial',scope:['fixture:nas']}),signal:AbortSignal.timeout(1000)});
  assert.equal(removed.status,404);
  console.log('PASS: real-only npm start, loopback health/assets, legacy sample quarantine and actual compiled discovery worker TCP socket and fixed-path Glances HTTP stats');

} catch (error) {
  failed = true;
  console.error('FAIL: production smoke check:', error.message);
} finally {
  clearTimeout(timeout);
  // Give cleanup its own bounded window, even if the exercise deadline expired.
  try {
    signalGroup('SIGTERM');
    const stop = Date.now() + 5_000;
    while (Date.now() < stop && (!exited || groupExists() || !(await portIsClosed()))) await delay(50);
    assert.ok(!server || (exited && !groupExists() && await portIsClosed()), 'Graceful shutdown did not finish in five seconds');
    if (server) assert.ok(exitCode === 0 || exitSignal === 'SIGTERM', 'npm start exited unexpectedly');
    if (!failed) console.log('PASS: graceful process-group shutdown and closed loopback listener');
  } catch (error) {
    failed = true;
    console.error('FAIL: smoke cleanup:', error.message);
    signalGroup('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true });
  if (failed && log) console.error('Bounded fixture-server log:\n' + log);
}
if (failed) process.exitCode = 1;
