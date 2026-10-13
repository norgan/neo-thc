import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSocket} from 'node:dgram';
import type {Worker} from 'node:worker_threads';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {GLANCES_NAME,encodeName,readDnsName,nameKey,glancesQuestion,parseGlancesDns,resolveGlancesMdns} from '../server/glances-mdns.mjs';
import {GlancesEnricher,validateResolution,type createGlancesWorker} from '../server/glances-enrichment.js';
import {glancesRequest,GLANCES_PATHS} from '../server/glances.js';
import {parseDiscovery} from '../server/discovery-scope.js';
import {discoveryObservation} from '../server/discovery-runner.js';
import {createPacer} from '../server/discovery-network.mjs';
import {COMMON_TCP_PORTS} from '../shared/ports.js';
import {Store} from '../server/store.js';
import {JobManager} from '../server/jobs.js';
import type {CollectorAdapter} from '../server/collector.js';
import type {GlancesEnrichment,GlancesResolution,Job} from '../shared/types.js';
const iface={id:'mdns-interface',name:'Test interface',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
const input=(extra:Record<string,unknown>={})=>({requestId:'auto-test-request',interfaceId:iface.id,cidr:iface.cidr,methods:['mdns'],ports:[],
  linkScopeConfirmed:true,confirmScope:true,glancesScheme:'http',...extra});
const plan=()=>parseDiscovery(input(),[iface],true).plan;
const instance=[Buffer.from('Monitor. café'),...GLANCES_NAME],target=[Buffer.from('monitor-host')];
function rr(owner:Buffer[],type:number,data:Buffer,ttl=10){
  const header=Buffer.alloc(10);header.writeUInt16BE(type);header.writeUInt16BE(1,2);header.writeUInt32BE(ttl,4);header.writeUInt16BE(data.length,8);
  return Buffer.concat([encodeName(owner),header,data]);
}
function srv(port=61208){const data=Buffer.alloc(6);data.writeUInt16BE(port,4);return Buffer.concat([data,encodeName(target)]);}
function txt(...values:string[]){return Buffer.concat(values.flatMap((value)=>[Buffer.from([Buffer.byteLength(value)]),Buffer.from(value)]));}
function records(mode='all',ttl=10){
  return [rr(GLANCES_NAME,12,encodeName(instance),ttl),rr(instance,33,srv(),ttl),
    rr(instance,16,txt(mode==='rpc'?'protocol=rpc':'protocol=rest','path=/never-follow'),ttl),
    rr(target,1,Buffer.from(mode==='mismatch'?[198,51,100,1]:[192,0,2,1]),ttl)];
}
function packet(query:Buffer,rows:Buffer[]){
  const header=Buffer.alloc(12);header.writeUInt16BE(query.readUInt16BE(0));header.writeUInt16BE(0x8400,2);
  header.writeUInt16BE(1,4);header.writeUInt16BE(rows.length,6);
  return Buffer.concat([header,query.subarray(12),...rows]);
}
function socketFixture(mode='all'){
  const sent:Buffer[]=[],calls:unknown[]=[];
  class Socket extends EventEmitter{
    bind(port:number,address:string,callback:()=>void){calls.push({bind:port,address});queueMicrotask(callback);}
    setTTL(value:number){calls.push({ttl:value});}setMulticastTTL(value:number){calls.push({multicastTTL:value});}
    setMulticastInterface(address:string){calls.push({interface:address});}
    send(query:Buffer,port:number,address:string,callback:(error:null)=>void){
      sent.push(query);calls.push({port,address});callback(null);
      const type=query.readUInt16BE(query.length-4),rows=records(mode);
      const chosen=mode==='split'?[rows[type===12?0:type===33?1:type===16?2:3]]:rows;
      if(mode==='duplicate-txt')chosen[2]=rr(instance,16,txt('PROTOCOL=rest','protocol=rpc'));
      if(mode==='conflict')chosen.push(rr(instance,33,srv(1234)));
      if(mode==='withdraw')chosen.push(rr(instance,33,srv(),0));
      if(mode==='many-a')chosen.push(rr(target,1,Buffer.from([198,51,100,8])));
      this.emit('message',packet(query,chosen),{port:5353,address:'192.0.2.1'});
    }
    close(callback?:()=>void){calls.push('closed');callback?.();}
  }
  return {sent,calls,factory:(()=>new Socket()) as unknown as typeof createSocket};
}
test('fresh Glances DNS-SD consumes complete additionals or correlated followups and preserves label bytes',async()=>{
  for(const mode of ['all','split','duplicate-txt','many-a']){
    const fixture=socketFixture(mode),result=await resolveGlancesMdns(plan(),new AbortController().signal,fixture.factory,5);
    assert.equal(result.candidates[0].protocol,'rest');assert.equal(result.candidates[0].port,61208);assert.equal(result.candidates[0].issue,null);
    assert.equal(result.candidates[0].instance,'Monitor. café._glances._tcp.local');assert.equal(result.datagramsSent,mode==='split'?4:1);
    assert.ok(fixture.calls.some((item)=>JSON.stringify(item)===JSON.stringify({bind:0,address:iface.address})));
    assert.ok(fixture.calls.some((item)=>JSON.stringify(item)===JSON.stringify({port:5353,address:'224.0.0.251'})));
    assert.ok(fixture.calls.includes('closed'));assert.ok(fixture.sent.length<=7);
  }
});
test('RPC, conflicting SRV, mismatched A and TTL withdrawal never produce an actionable REST endpoint',async()=>{
  for(const [mode,issue] of [['rpc','rpc_only'],['conflict','conflict'],['mismatch','address_mismatch'],['withdraw','expired']]){
    const fixture=socketFixture(mode),result=await resolveGlancesMdns(plan(),new AbortController().signal,fixture.factory,5);
    assert.equal(result.candidates[0].issue,issue);
  }
});
test('DNS parser rejects bad identity, compression, count and record bounds before promotion',()=>{
  const query=glancesQuestion(GLANCES_NAME,12,123),valid=packet(query,records());
  assert.equal(parseGlancesDns(valid,GLANCES_NAME,12,123).length,4);
  assert.throws(()=>parseGlancesDns(valid,GLANCES_NAME,12,124));
  assert.throws(()=>parseGlancesDns(valid,instance,12,123));
  assert.throws(()=>parseGlancesDns(valid.subarray(0,-1),GLANCES_NAME,12,123));
  assert.throws(()=>readDnsName(Buffer.from([0xc0,0]),0));
  const count=Buffer.from(valid);count.writeUInt16BE(65535,6);assert.throws(()=>parseGlancesDns(count,GLANCES_NAME,12,123));
  assert.notEqual(nameKey([Buffer.from('a.b')]),nameKey([Buffer.from('a'),Buffer.from('b')]));
});
test('automatic reads require new full-link consent and are absent from ordinary plans',()=>{
  const ordinary=parseDiscovery({...input(),glancesScheme:undefined,methods:['tcp'],ports:[443],cidr:'192.0.2.1/32',linkScopeConfirmed:false},[iface],true);
  assert.equal(ordinary.plan.glances,undefined);
  for(const extra of [{linkScopeConfirmed:false},{cidr:'192.0.2.0/25'},{glancesScheme:['https']},{glancesScheme:'automatic'}])
    assert.throws(()=>parseDiscovery(input(extra),[iface],true));
  assert.equal(plan().glances!.maxRequests,12);
});
test('common homelab profile fits a /24 without reducing hosts and rate pacing bounds fast outcomes',async()=>{
  const ports=COMMON_TCP_PORTS.map(([port])=>port);
  assert.equal(ports.length,48);assert.equal(new Set(ports).size,48);
  const p=parseDiscovery(input({methods:['tcp'],ports,glancesScheme:undefined,linkScopeConfirmed:false}),[iface],true).plan;
  assert.equal(p.targets.length,253);assert.equal(p.tcpBudget,12144);assert.ok(p.estimatedMaxMs!<=p.maxDurationMs!);
  assert.throws(()=>parseDiscovery(input({methods:['tcp'],ports,tcpConcurrency:8,maxDurationMs:60000}),[iface],true));
  let clock=0;const waits:number[]=[],controller=new AbortController();
  const pace=createPacer(controller.signal,()=>clock,async(ms)=>{waits.push(ms);clock+=ms;});
  for(let index=0;index<100;index++)await pace();
  assert.equal(clock,990);assert.ok(waits.every((ms)=>ms===10));controller.abort();await assert.rejects(pace());
});
const resolved:GlancesResolution={candidates:[{address:'192.0.2.1',instance:'Monitor._glances._tcp.local',port:61208,protocol:'rest',ttlMs:10000,issue:null}],
  datagramsSent:1,packetsReceived:1,omitted:0,issues:[]};
function workerFactory(result=resolved,delayMs=0){
  let terminated=false;
  const factory=((data:{attemptId:string})=>{
    const worker=new EventEmitter() as EventEmitter&{stdout:{resume:()=>void};stderr:{resume:()=>void};terminate:()=>Promise<number>;unref:()=>void};
    worker.stdout={resume(){}};worker.stderr={resume(){}};worker.unref=()=>{};
    worker.terminate=async()=>{await delay(delayMs);terminated=true;return 0;};
    setTimeout(()=>worker.emit('message',JSON.stringify({v:1,attemptId:data.attemptId,result})),0);
    return worker as unknown as Worker;
  }) as unknown as typeof createGlancesWorker;
  return {factory,terminated:()=>terminated};
}
function seed(store:Store):Job{
  const {plan:p,spec}=parseDiscovery(input(),[iface],true);
  const job:Job={id:'automatic-job',requestId:'automatic-request',spec,status:'running',createdAt:1,startedAt:1,finishedAt:null,completedTargets:1,totalTargets:1,cyclesCompleted:1,observationsAdded:1,errors:[]};
  store.saveJob(job);
  store.ingest([discoveryObservation({address:'192.0.2.1',ports:[],dns:{state:'not_requested',names:[]},mdns:['_glances._tcp.local'],ssdp:[],nbns:false,ttlMs:10000},p,job.id)]);
  return job;
}
test('parent validates resolved endpoints then reads real loopback HTTP through a test-only mapping',async()=>{
  const calls:string[]=[],server=createServer((request,response)=>{
    calls.push(request.url!);response.setHeader('Content-Type','application/json');
    const data:Record<string,unknown>={'/api/4/version':'4.3.3','/api/4/system':{hostname:'test.example'},'/api/4/cpu':{total:6.3},
      '/api/4/mem':{percent:31.3,total:1000,available:687},'/api/4/fs':[],'/api/4/uptime':'1 hour'};
    response.end(JSON.stringify(data[request.url!]));
  });
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const store=new Store(),job=seed(store),worker=workerFactory(),states:GlancesEnrichment[]=[];
  const enricher=new GlancesEnricher(store,()=>[iface],worker.factory,(target,path,signal)=>{
    assert.equal(target.address,'192.0.2.1');assert.equal(worker.terminated(),true);
    return glancesRequest({...target,address:'127.0.0.1',sourceAddress:'127.0.0.1',port:address.port},path,signal);
  });
  try{
    assert.equal(await enricher.run(job,new AbortController().signal,(state)=>states.push(state)),false);
    assert.deepEqual(calls,[...GLANCES_PATHS]);assert.equal(store.stats()[0].cpuPercent,6.3);
    assert.equal(states.at(-1)!.phase,'completed');assert.equal(store.observationCount(),1);
    assert.throws(()=>validateResolution({...resolved,candidates:[{...resolved.candidates[0],address:'198.51.100.1'}]},plan()));
  }finally{store.close();server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});
test('cancelled HTTP enrichment retains base evidence and holds the one job slot until cleanup',async()=>{
  const store=new Store();let begin!:()=>void;const begun=new Promise<void>((resolve)=>{begin=resolve;});
  const worker=workerFactory();
  const enricher=new GlancesEnricher(store,()=>[iface],worker.factory,async(_target,path,signal)=>{
    if(path==='/api/4/version')return '4.3.3';
    begin();await new Promise<void>((resolve)=>signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(30);throw new Error('cancelled');
  });
  const adapter:CollectorAdapter={id:'discovery-v1',capabilities:['network-observations'],targets:[],
    async collect(_target,context){return [discoveryObservation({address:'192.0.2.1',ports:[],dns:{state:'not_requested',names:[]},mdns:['_glances._tcp.local'],ssdp:[],nbns:false,ttlMs:10000},context.discovery!,context.jobId!)];}};
  const jobs=new JobManager(store,adapter,750,adapter,enricher),spec=parseDiscovery(input(),[iface],true).spec;
  try{
    const job=jobs.start('cancel-automatic-001',spec);await begun;jobs.cancel(job.id);
    assert.throws(()=>jobs.start('overlapping-automatic',spec),/Another collection/);
    await delay(80);assert.equal(store.job(job.id)!.status,'cancelled');assert.equal(store.observationCount(),1);
    assert.equal(jobs.busy,false);assert.equal(store.stats().length,1);
  }finally{await jobs.shutdown();store.close();}
});
