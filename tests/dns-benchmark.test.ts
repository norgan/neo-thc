import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {parseDnsBenchmark,dnsBenchmarkPreview} from '../server/dns-benchmark.js';
import {benchmarkComparisons,DNS_BENCHMARK_LIMITS,type DnsBenchmarkReport} from '../shared/dns-benchmark.js';
import type {Job} from '../shared/types.js';
import {allowedRemotePath} from '../server/frontend.js';
import {Store} from '../server/store.js';

const headers={host:'127.0.0.1:4318','x-neo-client':'local-ui'};
const input={requestId:'dns-benchmark-test',hostnames:['cloud.example'],resolvers:['192.0.2.53','2001:db8::53'],port:53,
  protocols:['udp','tcp'],recordTypes:['A','AAAA'],requests:10,timeoutSeconds:1};
function fakeRunner(options:{unavailable?:boolean;slow?:boolean}={}){
  let calls=0,checks=0,closed=false;
  return {problem:null,
    async capability(signal?:AbortSignal){signal?.throwIfAborted();checks++;return {available:!options.unavailable,version:options.unavailable?null:'0.14.0',reason:options.unavailable?'Install dns-bench 0.14.0 on this collector.':null};},
    async run(job:Job,signal:AbortSignal,publish:(report:DnsBenchmarkReport)=>void){
      calls++;const plan=job.spec.dnsBenchmark!,comparisons=benchmarkComparisons(plan);
      const report:DnsBenchmarkReport={complete:false,tool:'dns-bench',toolVersion:'0.14.0',vantage:'Isolated synthetic test collector',startedAt:Date.now(),updatedAt:Date.now(),totalComparisons:comparisons.length,results:[]};
      try{
        publish(structuredClone(report));
        for(const comparison of comparisons){
          signal.throwIfAborted();report.results.push({...comparison,port:plan.port,family:comparison.resolver.includes(':')?6:4,status:'complete',
            totalRequests:plan.requests,successfulRequests:plan.requests,successPercent:100,minMs:1,avgMs:2,maxMs:3,
            lastResolvedAddress:comparison.recordType==='A'?'192.0.2.20':'2001:db8::20',issue:null});
          publish(structuredClone(report));
          if(options.slow)await delay(10000,undefined,{signal});
        }
        report.complete=true;publish(structuredClone(report));return false;
      }finally{closed=true;}
    },calls:()=>calls,checks:()=>checks,closed:()=>closed};
}
async function terminal(store:Store,id:string){
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){const job=store.job(id)!;if(!['queued','running'].includes(job.status))return job;await delay(5);}
  throw new Error('Benchmark did not finish');
}

test('benchmark plan covers resolver transport families independently of A/AAAA and UDP/TCP',()=>{
  const {plan,spec}=parseDnsBenchmark(input),preview=dnsBenchmarkPreview(plan);
  assert.equal(preview.comparisons,8);assert.equal(preview.lookupIterations,80);
  assert.equal(preview.maxDurationMs,DNS_BENCHMARK_LIMITS.maxDurationMs);
  assert.equal(spec.maxCycles,1);
  for(const resolver of input.resolvers)for(const protocol of input.protocols)for(const recordType of input.recordTypes)
    assert.ok(benchmarkComparisons(plan).some(row=>row.resolver===resolver&&row.protocol===protocol&&row.recordType===recordType));
  assert.deepEqual(parseDnsBenchmark({...input,resolvers:['2001:0db8:0:0:0:0:0:53'],hostnames:['CLOUD.Example.']}).plan.resolvers,['2001:db8::53']);
  assert.deepEqual(parseDnsBenchmark({...input,resolvers:['fe80:0:0:0:0:0:0:53%12']}).plan.resolvers,['fe80::53%12']);
});

test('benchmark API rejects scope expansion, injected arguments, ambiguous input and invalid bounds before a process can start',()=>{
  for(const extra of [
    {hostnames:[]},{hostnames:['short']},{hostnames:['https://cloud.example/path']},{hostnames:['cloud.example','CLOUD.EXAMPLE.']},
    {hostnames:['cloud.example\n--domain other.example']},{hostnames:['printer.local']},
    {resolvers:[]},{resolvers:['resolver.example']},{resolvers:['192.0.2.53:53']},{resolvers:['::']},{resolvers:['ff02::1']},
    {resolvers:['fe80::1']},{resolvers:['fe80::1%Ethernet']},{resolvers:['fe80::1%0']},{resolvers:['2001:db8::53%12']},{resolvers:['2001:db8::53','2001:0db8::53']},
    {resolvers:['255.255.255.255']},{resolvers:['169.254.169.254']},{resolvers:['::ffff:127.0.0.1']},
    {protocols:['https']},{protocols:['udp','udp']},{protocols:[]},{recordTypes:['ANY']},{recordTypes:['A','A']},
    {requests:0},{requests:51},{timeoutSeconds:0},{timeoutSeconds:3},{port:0},{port:65536},{port:'53'},
    {binary:'/bin/sh'},{arguments:['--custom-servers-file','/private']},{confirmed:'true'},
  ])assert.throws(()=>parseDnsBenchmark({...input,...extra}));
  assert.throws(()=>parseDnsBenchmark(input,true));
  assert.equal(parseDnsBenchmark({...input,confirmed:true},true).plan.resolvers.length,2);
  assert.deepEqual(parseDnsBenchmark({...input,resolvers:['127.0.0.1','::1'],port:5353}).plan.resolvers,['127.0.0.1','::1']);
});

test('benchmark options preserve configured IPv6, and previews have no probe or capability side effects',async()=>{
  const runner=fakeRunner();
  const {app}=createApp({dnsBenchmarkRunner:runner,readDiagnosticOptions:async()=>({source:'Windows fixture',gateway:null,interfaces:[],
    resolvers:[{interface:'Fixture adapter',address:'2001:db8::53',family:6,supported:true},{interface:'Fixture adapter',address:'192.0.2.53',family:4,supported:true},
      {interface:'Fixture adapter',address:'fe80::53%12',family:6,supported:false,reason:'Unsupported by native diagnostic'}]})});
  try{
    const preview=await app.inject({method:'POST',url:'/api/v1/dns-benchmark/preview',headers,payload:input});
    assert.equal(preview.statusCode,200);assert.equal(preview.json().comparisons,8);assert.equal(runner.calls(),0);assert.equal(runner.checks(),0);
    const options=await app.inject({url:'/api/v1/dns-benchmark/options',headers});
    assert.equal(options.statusCode,200);assert.equal(options.json().resolvers[0].address,'2001:db8::53');
    assert.equal(options.json().resolvers[2].supported,true);assert.equal(options.json().resolvers[2].reason,undefined);
    assert.ok(options.json().publicResolvers.some((row:{address:string})=>row.address.includes(':')));assert.equal(runner.calls(),0);
  }finally{await app.close();}
});

test('benchmark jobs share capacity, retain IPv6 evidence and use stable idempotency',async()=>{
  const runner=fakeRunner({slow:true}),{app,store}=createApp({dnsBenchmarkRunner:runner});
  const submit=(payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/v1/dns-benchmark/jobs',headers,payload});
  try{
    assert.equal((await submit(input)).statusCode,400);assert.equal(runner.calls(),0);
    const first=await submit({...input,confirmed:true});assert.equal(first.statusCode,202);const id=first.json().job.id;
    assert.equal(first.json().job.synthetic,false);assert.equal(first.json().job.totalTargets,8);
    assert.equal((await submit({...input,confirmed:true})).json().job.id,id);
    assert.equal((await submit({...input,requestId:'another-benchmark',confirmed:true})).statusCode,409);
    assert.equal((await submit({...input,requests:20,confirmed:true})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{kind:'dns',requestId:'other-diagnostic',hostname:'cloud.example',resolvers:['192.0.2.53'],systemLookup:false,confirmed:true}})).statusCode,409);
    const until=Date.now()+1000;while(!store.job(id)?.dnsBenchmarkReport?.results.length&&Date.now()<until)await delay(2);
    await app.inject({method:'POST',url:'/api/v1/jobs/'+id+'/cancel',headers,payload:{}});
    const cancelled=await terminal(store,id);assert.equal(cancelled.status,'cancelled');assert.equal(runner.closed(),true);
    assert.equal(cancelled.dnsBenchmarkReport?.complete,false);assert.equal(cancelled.dnsBenchmarkReport?.results.length,1);
    assert.equal(cancelled.completedTargets,1);assert.equal(store.assets().length,0);
    const snapshot=(await app.inject({url:'/api/v1/snapshot',headers})).json();assert.equal(snapshot.jobs[0].id,id);
  }finally{await app.close();}
});

test('successful benchmark persists complete matrix, and a missing tool leaves normal diagnostics usable',async()=>{
  const runner=fakeRunner(),{app,store}=createApp({dnsBenchmarkRunner:runner});
  try{
    const start=await app.inject({method:'POST',url:'/api/v1/dns-benchmark/jobs',headers,payload:{...input,confirmed:true}});
    const done=await terminal(store,start.json().job.id);assert.equal(done.status,'completed');assert.equal(done.dnsBenchmarkReport?.results.length,8);
    assert.equal(done.dnsBenchmarkReport?.complete,true);assert.ok(done.dnsBenchmarkReport?.results.some(row=>row.family===6));
  }finally{await app.close();}
  const absent=fakeRunner({unavailable:true}),other=createApp({dnsBenchmarkRunner:absent});
  try{
    assert.equal((await other.app.inject({method:'POST',url:'/api/v1/dns-benchmark/jobs',headers,payload:{...input,confirmed:true}})).statusCode,503);
    assert.equal(absent.calls(),0);assert.equal((await other.app.inject({url:'/api/v1/health',headers})).json().status,'ok');
    assert.equal((await other.app.inject({method:'POST',url:'/api/v1/diagnostics/preview',headers,payload:{kind:'dns',requestId:'ordinary-dns',hostname:'cloud.example',resolvers:['192.0.2.53'],systemLookup:false}})).statusCode,200);
  }finally{await other.app.close();}
});

test('restart preserves an incomplete benchmark matrix without running it again',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neo-benchmark-recovery-'));
  try{
    const path=join(directory,'neo.sqlite'),original=new Store(path,true),{spec}=parseDnsBenchmark(input);
    const job:Job={id:'interrupted-benchmark',requestId:input.requestId,spec,synthetic:false,status:'running',createdAt:Date.now(),startedAt:Date.now(),finishedAt:null,
      completedTargets:0,totalTargets:8,cyclesCompleted:0,observationsAdded:0,errors:[],dnsBenchmarkReport:{complete:false,tool:'dns-bench',toolVersion:'0.14.0',vantage:'Prior collector',
        startedAt:Date.now(),updatedAt:Date.now(),totalComparisons:8,results:[]}};
    original.saveJob(job);original.close();
    const runner=fakeRunner(),{app,store}=createApp({dbPath:path,dnsBenchmarkRunner:runner});
    try{assert.equal(store.job(job.id)?.status,'interrupted');assert.equal(store.job(job.id)?.dnsBenchmarkReport?.complete,false);assert.equal(runner.calls(),0);}
    finally{await app.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('remote collector exposes only the fixed benchmark options, preview and job routes',()=>{
  assert.equal(allowedRemotePath('GET','/api/v1/dns-benchmark/options'),true);
  assert.equal(allowedRemotePath('POST','/api/v1/dns-benchmark/preview'),true);
  assert.equal(allowedRemotePath('POST','/api/v1/dns-benchmark/jobs'),true);
  assert.equal(allowedRemotePath('GET','/api/v1/dns-benchmark/jobs'),false);
  assert.equal(allowedRemotePath('POST','/api/v1/dns-benchmark/execute'),false);
});
