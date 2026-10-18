import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server,type RequestListener,type IncomingMessage} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer as createHttpsServer,request as httpsRequest,type RequestOptions} from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import {glancesRequest,readGlances,normalizeGlances,GLANCES_PATHS,GlancesError,type GlancesTarget} from '../server/glances.js';
import {createApp} from '../server/app.js';
import {parseDiscovery} from '../server/discovery-scope.js';
import {discoveryObservation} from '../server/discovery-runner.js';
import {Store} from '../server/store.js';
import {connectionCheck} from '../server/diagnostic-network.mjs';
import {transferCheck} from '../server/internet-network.mjs';
import type {Job,DiscoveryInterface} from '../shared/types.js';
const sample:Record<string,unknown>={
  '/api/4/version':'4.5.8','/api/4/system':{hostname:'server.example',os_name:'Example OS',os_version:'1',secret:'drop'},
  '/api/4/cpu':{total:0},'/api/4/mem':{percent:25,total:1024,available:768},
  '/api/4/fs':[{mnt_point:'/',fs_type:'examplefs',size:1000,used:250,free:700,percent:25,options:'discard'}],
  '/api/4/uptime':'1 day',
};
async function endpoint(handler:RequestListener):Promise<{server:Server;target:GlancesTarget;close:()=>Promise<void>}> {
  const server=createServer(handler);await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return {server,target:{assetId:'test-asset',address:'127.0.0.1',sourceAddress:'127.0.0.1',scheme:'http',port:address.port,requestId:'test-request-001'},
    close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}};
}
test('real loopback Glances transport reads only six fixed GET paths and preserves zero and reserved space',async()=>{
  const calls:string[]=[];
  const fixture=await endpoint((request,response)=>{
    assert.equal(request.method,'GET');assert.equal(request.socket.remoteAddress,'127.0.0.1');
    assert.equal(request.headers.authorization,undefined);assert.equal(request.headers['accept-encoding'],'identity');
    calls.push(request.url!);response.setHeader('Content-Type','application/json');response.end(JSON.stringify(sample[request.url!]));
  });
  try {
    const result=await readGlances(fixture.target,new AbortController().signal);
    assert.deepEqual(calls,[...GLANCES_PATHS]);assert.equal(result.status,'complete');assert.equal(result.cpuPercent,0);
    assert.equal(result.filesystems![0].freeBytes,700);assert.equal(result.memory!.availableBytes,768);
    assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(JSON.stringify(result).includes('options'),false);
  } finally {await fixture.close();}
});
test('unsupported version and authentication stop further reads; valid partial metrics survive a missing plugin',async()=>{
  let calls:string[]=[];
  const read=async(_target:GlancesTarget,path:typeof GLANCES_PATHS[number])=>{calls.push(path);return path===GLANCES_PATHS[0]?'3.4.0':sample[path];};
  const target={assetId:'test',address:'127.0.0.1',sourceAddress:'127.0.0.1',scheme:'http' as const,port:1234,requestId:'test-id-001'};
  assert.equal((await readGlances(target,new AbortController().signal,read)).issues[0].code,'unsupported_version');
  assert.deepEqual(calls,[GLANCES_PATHS[0]]);calls=[];
  const auth=await readGlances(target,new AbortController().signal,async(_t,path)=>{calls.push(path);if(path!=='/api/4/version')throw new GlancesError('authentication_required');return '4.5.8';});
  assert.equal(auth.status,'failed');assert.deepEqual(calls,GLANCES_PATHS.slice(0,2));
  const partial=await readGlances(target,new AbortController().signal,async(_t,path)=>{if(path==='/api/4/fs')throw new GlancesError('not_found');return sample[path];});
  assert.equal(partial.status,'partial');assert.equal(partial.cpuPercent,0);assert.equal(partial.filesystems,null);
  assert.deepEqual(normalizeGlances('/api/4/fs',[]),[]);
  for(const missing of [null,'',undefined])assert.throws(()=>normalizeGlances('/api/4/uptime',missing));
  for(const [path,value] of [['/api/4/cpu',{total:101}],['/api/4/mem',{total:1,available:2,percent:0}],['/api/4/fs',[{mnt_point:'/',size:100,used:101,free:0,percent:0}]]] as const)
    assert.throws(()=>normalizeGlances(path,value));
});
test('redirects, authentication, compression and oversized responses are bounded with no follow-up',async()=>{
  for(const kind of ['redirect','auth','compressed','large','headers'] as const) {
    let calls=0;
    const fixture=await endpoint((_request,response)=>{
      calls++;response.setHeader('Content-Type','application/json');
      if(kind==='redirect'){response.writeHead(302,{Location:'http://198.51.100.1/private'});response.end();}
      else if(kind==='auth'){response.writeHead(401);response.end('untrusted body');}
      else if(kind==='compressed'){response.setHeader('Content-Encoding','gzip');response.end('{}');}
      else if(kind==='headers'){response.setHeader('X-Large','x'.repeat(9000));response.end('{}');}
      else response.end('"'+ 'x'.repeat(262145)+'"');
    });
    try {
      await assert.rejects(glancesRequest(fixture.target,'/api/4/version',new AbortController().signal),GlancesError);
      assert.equal(calls,1);
    } finally {await fixture.close();}
  }
});
test('slow drip has an absolute deadline and cancellation closes the active socket before settling',async()=>{
  let active=0;
  const fixture=await endpoint((request,response)=>{
    active++;request.socket.once('close',()=>active--);
    response.setHeader('Content-Type','application/json');response.write('"');
    const timer=setInterval(()=>response.write(' '),50);response.once('close',()=>clearInterval(timer));
  });
  try {
    const started=Date.now();
    await assert.rejects(glancesRequest(fixture.target,'/api/4/version',new AbortController().signal),(error:unknown)=>error instanceof GlancesError&&error.code==='timeout');
    assert.ok(Date.now()-started<3000);await delay(10);assert.equal(active,0);
    const controller=new AbortController(),pending=glancesRequest(fixture.target,'/api/4/version',controller.signal);
    await delay(25);controller.abort();
    await assert.rejects(pending,(error:unknown)=>error instanceof GlancesError&&error.code==='cancelled');
    await delay(10);assert.equal(active,0);
  } finally {await fixture.close();}
});
const iface:DiscoveryInterface={id:'test-interface',name:'Test link',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
const settings={requestId:'scoped-discovery',interfaceId:iface.id,cidr:'192.0.2.1/32',methods:['tcp'],ports:[443],confirmScope:true};
const headers={host:'127.0.0.1:4318','x-neo-client':'local-ui'};
function seed(store:Store) {
  const {plan,spec}=parseDiscovery(settings,[iface],true);
  const job:Job={id:'scoped-job',requestId:'scoped-discovery',spec,status:'completed',createdAt:1,startedAt:1,finishedAt:2,
    completedTargets:1,totalTargets:1,cyclesCompleted:1,observationsAdded:1,errors:[]};
  store.saveJob(job);
  store.ingest([discoveryObservation({address:'192.0.2.1',ports:[{port:443,state:'open'}],dns:{state:'not_requested',names:[]},mdns:[],ssdp:[],nbns:false,ttlMs:60000},plan,job.id)]);
  return store.assets()[0].id;
}
test('API preview never connects, read requires exact explicit scope/confirmation and repeated request is idempotent',async()=>{
  let calls=0;
  const {app,store}=createApp({discoveryInterfaces:()=>[iface],glancesRead:async(_target,path)=>{calls++;return sample[path];}});
  try {
    const id=seed(store),body={requestId:'stats-request-001',scheme:'http',port:61208};
    const inject=(suffix:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/v1/assets/'+id+'/glances/'+suffix,headers,payload});
    assert.equal((await inject('preview',body)).statusCode,200);assert.equal(calls,0);
    assert.equal((await inject('read',body)).statusCode,400);
    for(const extra of [{url:'http://198.51.100.1'},{headers:{Authorization:'forbidden'}},{path:'/api/4/all'},{port:0},{scheme:['https']},{scheme:{toString:'https'}}])
      assert.equal((await inject('read',{...body,confirmed:true,...extra})).statusCode,400);
    assert.equal((await inject('read',{...body,confirmed:true})).statusCode,200);assert.equal(calls,6);
    assert.equal((await inject('read',{...body,confirmed:true})).statusCode,200);assert.equal(calls,6);
    assert.equal((await inject('read',{...body,port:1,confirmed:true})).statusCode,409);
    assert.equal(store.stats().length,1);assert.equal(store.stats()[0].cpuPercent,0);
  } finally {await app.close();}
});
test('stats share discovery capacity and cancellation preserves only completed sections',async()=>{
  let started!:()=>void;const ready=new Promise<void>((resolve)=>{started=resolve;});
  const {app,store}=createApp({discoveryInterfaces:()=>[iface],glancesRead:async(_target,path,signal)=>{
    if(path==='/api/4/version')return '4.5.8';
    started();await new Promise<void>((resolve)=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new GlancesError('cancelled');
  }});
  try {
    const id=seed(store),payload={requestId:'stats-cancel-001',scheme:'http',port:61208,confirmed:true};
    const pending=app.inject({method:'POST',url:'/api/v1/assets/'+id+'/glances/read',headers,payload});
    await ready;
    assert.equal((await app.inject({method:'POST',url:'/api/v1/discovery/jobs',headers,payload:settings})).statusCode,409);
    assert.equal((await app.inject({url:'/api/v1/snapshot',headers})).json().statsActive,payload.requestId);
    await app.inject({method:'POST',url:'/api/v1/stats/'+payload.requestId+'/cancel',headers,payload:{}});
    assert.equal((await pending).statusCode,200);
    assert.equal(store.stats()[0].issues[0].code,'cancelled');
    assert.equal((await app.inject({url:'/api/v1/snapshot',headers})).json().statsActive,null);
  } finally {await app.close();}
});
test('additive schema upgrade preserves legacy rows and records genuine stats without wiping evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'neo-schema-')),path=join(dir,'test.sqlite');
  try {
    const first=new Store(path);seed(first);first.close();
    const db=new DatabaseSync(path);db.exec('DROP TABLE stats_snapshots; PRAGMA user_version=1');db.close();
    const upgraded=new Store(path);
    try {assert.equal(upgraded.assets().length,1);assert.equal(upgraded.jobs().length,1);assert.deepEqual(upgraded.stats(),[]);}
    finally {upgraded.close();}
    const check=new DatabaseSync(path);assert.equal((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,2);check.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('environment-proxy mode cannot divert the explicit private-agent transport',async()=>{
  let proxyCalls=0,targetCalls=0;
  const proxy=await endpoint((_request,response)=>{proxyCalls++;response.writeHead(502);response.end();});
  const direct=await endpoint((_request,response)=>{targetCalls++;response.setHeader('Content-Type','application/json');response.end('"4.5.8"');});
  try {
    const source=new URL('../server/glances.ts',import.meta.url).href;
    const script='import {glancesRequest} from '+JSON.stringify(source)+';const result=await glancesRequest('+JSON.stringify(direct.target)+',"/api/4/version",new AbortController().signal);process.stdout.write(JSON.stringify(result));';
    const sentinel='http://127.0.0.1:'+proxy.target.port;
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',script],{
      timeout:5000,maxBuffer:8192,env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:sentinel,HTTPS_PROXY:sentinel,
        http_proxy:sentinel,https_proxy:sentinel,NO_PROXY:'',no_proxy:''},
    });
    assert.equal(JSON.parse(result.stdout),'4.5.8');assert.equal(targetCalls,1);assert.equal(proxyCalls,0);
  } finally {await direct.close();await proxy.close();}
});

test('failed schema migration rolls back the version and leaves original evidence intact',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'neo-migration-failure-')),path=join(dir,'test.sqlite');
  try {
    const first=new Store(path);seed(first);first.close();
    const db=new DatabaseSync(path);
    const before=db.prepare('SELECT payload FROM observations').all();
    db.exec('DROP TABLE stats_snapshots; CREATE INDEX stats_snapshots ON assets(label); PRAGMA user_version=1');db.close();
    assert.throws(()=>new Store(path));
    const check=new DatabaseSync(path);
    assert.equal((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);
    assert.deepEqual(check.prepare('SELECT payload FROM observations').all(),before);check.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('HTTPS rejects an untrusted certificate without sending application requests or downgrading',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'neo-tls-fixture-'));
  try {
    const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
    try {
      await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',key,'-out',cert],
        {timeout:10000,maxBuffer:8192});
    } catch(error) {
      if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'){t.skip('OpenSSL is required only for this ephemeral TLS fixture; CI supplies it');return;}
      throw error;
    }
    let requests=0;
    const server=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},(_request,response)=>{requests++;response.end('"4.5.8"');});
    server.on('tlsClientError',()=>{});
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    try {
      await assert.rejects(glancesRequest({assetId:'tls-test',requestId:'tls-test-request',scheme:'https',address:'127.0.0.1',sourceAddress:'127.0.0.1',port:address.port},
        '/api/4/version',new AbortController().signal),(error:unknown)=>error instanceof GlancesError&&error.code==='tls_validation_failed');
      assert.equal(requests,0);
      const diagnosis=await connectionCheck('cloud.example','127.0.0.1',address.port,true);
      assert.equal(diagnosis.tcp,'connected');assert.equal(diagnosis.tls,'certificate_error');assert.equal(requests,0);
      const transfer=await transferCheck(new AbortController().signal,((options:RequestOptions,callback:(value:IncomingMessage)=>void)=>
        httpsRequest({...options,hostname:'127.0.0.1',port:address.port,servername:'cloud.example'},callback)) as typeof httpsRequest);
      assert.equal(transfer.status,'tls_error');assert.equal(transfer.bytes,0);assert.equal(requests,0);
    } finally {server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));}
  } finally {await rm(dir,{recursive:true,force:true});}
});
