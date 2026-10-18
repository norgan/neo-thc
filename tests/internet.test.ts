import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {request as httpsRequest} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.js';
import {parseDiagnostic,validateDiagnosticResult} from '../server/diagnostics.js';
import {validateInternetCheck,type InternetProbes} from '../server/internet-runner.js';
import {mtuCheck,transferCheck,internetSettings,InternetCleanupError} from '../server/internet-network.mjs';
import {Store} from '../server/store.js';
import {diagnosticFindings,dnsOutcomeLabel} from '../shared/diagnostics.js';
import {internetFindings,latencySummary,DOWNLOAD_BYTES,DOWNLOAD_HOST,MEDIA_HOSTS,INTERNET_TARGET} from '../shared/internet.js';
import type {InternetCheck,DiagnosticReport,DiagnosticPlan,DnsCheck} from '../shared/types.js';

const headers={host:'127.0.0.1:4318','x-neo-client':'local-ui'};
const input={kind:'internet',requestId:'internet-fixture-id',resolvers:['192.0.2.53'],port:5353,gateway:'192.0.2.1',download:false};
const settings:InternetCheck={kind:'settings',status:'read',gateway:'192.0.2.1',interfaces:[{name:'Controlled link',family:4,mtu:1500,defaultRoute:true,dhcp:true}]};
const latency=(target:string):Extract<InternetCheck,{kind:'latency'}>=>({kind:'latency',target,durationMs:50,samples:[{status:'reply',rttMs:10},{status:'reply',rttMs:20},{status:'reply',rttMs:10}]});
const mtu:InternetCheck={kind:'mtu',target:INTERNET_TARGET,status:'at_least_1500',mtu:1500,probes:[{payload:1472,status:'reply'}],durationMs:2};
const dns=(type:'A'|'AAAA',status:DnsCheck['status']='answer'):DnsCheck=>({kind:'dns',source:'192.0.2.53',port:5353,recordType:type,status,durationMs:5,answers:status==='answer'?[{address:type==='A'?'192.0.2.4':'2001:db8::4',family:type==='A'?4:6,ttl:60}]:[]});
function fixtureProbes(calls:string[]=[]):InternetProbes{return {
  settings:async()=>{calls.push('settings');return structuredClone(settings) as Extract<InternetCheck,{kind:'settings'}>;},
  dns:async(hostname,source,type,port)=>{calls.push(hostname+':'+source+':'+port);return {...dns(type),source,port};},
  latency:async(target)=>{calls.push(target);return latency(target);},
  mtu:async(target)=>{calls.push('mtu:'+target);return structuredClone(mtu) as Extract<InternetCheck,{kind:'mtu'}>;},
  transfer:async()=>{calls.push('transfer');return {kind:'transfer',status:'byte_cap',bytes:DOWNLOAD_BYTES,durationMs:1000,mbps:DOWNLOAD_BYTES*8/1000000};},
};}
async function terminal(store:Store,id:string){const until=Date.now()+3000;while(Date.now()<until){const job=store.job(id)!;if(!['running','queued'].includes(job.status))return job;await delay(5);}throw new Error('Job did not settle');}
function report(dnsRows:DnsCheck[],internet:InternetCheck[]=[],kind:DiagnosticReport['kind']='dns'):DiagnosticReport{return {complete:true,hostname:'cloud.example',kind,vantage:'Controlled evidence',startedAt:1,updatedAt:1,dns:dnsRows,connections:[],internet,findings:[]};}

test('Internet scope is fixed, bounded, explicitly confirmed and rejects URLs, arbitrary destinations and invalid ports',()=>{
  const store=new Store();try{
    const result=parseDiagnostic(input,store);assert.equal(result.plan.hostname,'YouTube and Netflix');assert.equal(result.spec.maxDurationMs,45000);
    assert.throws(()=>parseDiagnostic(input,store,true));assert.equal(parseDiagnostic({...input,confirmed:true},store,true).plan.kind,'internet');
    for(const extra of [{hostname:'other.example'},{url:'https://elsewhere.example/'},{gateway:'http://192.0.2.1'},{gateway:'127.0.0.1'},{gateway:'fe80::1%23'},{download:'yes'},{port:0},{port:65536}])assert.throws(()=>parseDiagnostic({...input,...extra},store));
    assert.equal((parseDiagnostic({...input,gateway:null},store).plan as Extract<DiagnosticPlan,{kind:'internet'}>).gateway,null);
  }finally{store.close();}
});
test('NODATA explains ping -6, NXDOMAIN conflicts stay distinct and differing negative answers are visible',()=>{
  const value=report([dns('A'),dns('AAAA','no_data')]);const findings=diagnosticFindings(value);
  assert.ok(findings.some((row)=>row.code==='ipv4_only'&&row.detail.includes('ping -6')));assert.match(dnsOutcomeLabel('no_data'),/NODATA/);
  const conflict=diagnosticFindings(report([dns('A'),dns('AAAA','nxdomain')]));assert.ok(conflict.some((row)=>row.code==='name_conflict'));assert.equal(conflict.some((row)=>row.code==='ipv4_only'),false);
  const different=diagnosticFindings(report([dns('A','nxdomain'),dns('AAAA','nxdomain'),{...dns('A','no_data'),source:'2001:db8::53'},{...dns('AAAA','no_data'),source:'2001:db8::53'}]));
  assert.ok(different.some((row)=>row.code==='resolver_difference'));assert.equal(different.some((row)=>row.code==='ipv6_resolver'),false);
});
test('custom DNS port and fixed media hostname are bound to each returned result',()=>{
  const plan:Extract<DiagnosticPlan,{kind:'internet'}>={kind:'internet',hostname:'YouTube and Netflix',resolvers:['192.0.2.53'],port:5353,gateway:null,download:false};
  assert.equal(validateDiagnosticResult({...dns('A'),hostname:MEDIA_HOSTS[0]},plan,0).kind,'dns');
  for(const extra of [{hostname:MEDIA_HOSTS[1]},{port:53},{source:'198.51.100.53'},{hostname:'private.example'}])assert.throws(()=>validateDiagnosticResult({...dns('A'),hostname:MEDIA_HOSTS[0],...extra},plan,0));
});
test('Internet previews do no probing; approved runs save exact scopes, omit unselected transfer and share the collection slot',async()=>{
  const calls:string[]=[],{app,store}=createApp({internetProbes:fixtureProbes(calls)});
  try{
    const preview=await app.inject({method:'POST',url:'/api/v1/diagnostics/preview',headers,payload:input});assert.equal(preview.statusCode,200);assert.equal(preview.json().maxDurationMs,45000);assert.equal(calls.length,0);
    const denied=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:input});assert.equal(denied.statusCode,400);assert.equal(calls.length,0);
    const start=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,confirmed:true}});assert.equal(start.statusCode,202);
    const completed=await terminal(store,start.json().job.id);assert.equal(completed.status,'completed');assert.equal(completed.diagnosticReport!.complete,true);
    assert.equal(completed.diagnosticReport!.dns.length,4);assert.equal(completed.diagnosticReport!.internet!.length,4);assert.equal(calls.includes('transfer'),false);
    assert.deepEqual([...new Set(completed.diagnosticReport!.dns.map((row)=>row.hostname))],MEDIA_HOSTS);assert.equal(store.assets().length,0);
    const again=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,confirmed:true}});assert.equal(again.statusCode,200);assert.equal(again.json().job.id,completed.id);
  }finally{await app.close();}
});
test('approved transfer runs once and cancellation holds capacity until the current probe stops, retaining partial evidence',async()=>{
  const calls:string[]=[],transport=fixtureProbes(calls);let probing=false,stopped=false;
  transport.latency=async(target,signal)=>{probing=true;await new Promise<void>((resolve)=>signal.addEventListener('abort',()=>void delay(120).then(()=>{stopped=true;resolve();}),{once:true}));return latency(target);};
  const {app,store}=createApp({internetProbes:transport});try{
    const start=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,download:true,confirmed:true}}),id=start.json().job.id;
    while(!probing)await delay(5);
    await app.inject({method:'POST',url:'/api/v1/jobs/'+id+'/cancel',headers,payload:{}});
    const blocked=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,requestId:'second-internet-id',confirmed:true}});assert.equal(blocked.statusCode,409);
    const final=await terminal(store,id);assert.ok(stopped);assert.equal(final.status,'cancelled');assert.equal(final.diagnosticReport!.complete,false);assert.deepEqual(final.diagnosticReport!.findings,[]);assert.equal(final.diagnosticReport!.dns.length,4);assert.equal(calls.includes('transfer'),false);
  }finally{await app.close();}
  const next=createApp({internetProbes:fixtureProbes(calls)});try{
    const start=await next.app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,download:true,confirmed:true}});
    const final=await terminal(next.store,start.json().job.id);assert.ok(final.diagnosticReport!.internet!.some((row)=>row.kind==='transfer'));assert.equal(calls.filter((row)=>row==='transfer').length,1);
  }finally{await next.app.close();}
});
test('malformed settings fail without retaining raw process output or proceeding to the network',async()=>{
  const calls:string[]=[],transport=fixtureProbes(calls);transport.settings=async()=>({...settings,secret:'do-not-retain'}) as Extract<InternetCheck,{kind:'settings'}>;
  const {app,store}=createApp({internetProbes:transport});try{
    const start=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,confirmed:true}}),job=await terminal(store,start.json().job.id);
    assert.equal(job.status,'failed');assert.equal(JSON.stringify(job).includes('do-not-retain'),false);assert.deepEqual(calls,[]);
  }finally{await app.close();}
});
test('MTU evidence separates full-size success, a bounded smaller path and missing ICMP replies',async()=>{
  for(const limit of [1472,1464]){
    const result=await mtuCheck(INTERNET_TARGET,new AbortController().signal,async(_target,count,payload)=>Array.from({length:count},()=>({status:payload<=limit?'reply':'too_big',rttMs:payload<=limit?2:null})));
    assert.equal(result.mtu,limit+28);assert.equal(result.status,limit===1472?'at_least_1500':'reduced');assert.ok(result.probes.length<=11);validateInternetCheck(result,'mtu',INTERNET_TARGET);
  }
  const missing=await mtuCheck(INTERNET_TARGET,new AbortController().signal,async()=>[{status:'timeout',rttMs:null}]);assert.equal(missing.status,'inconclusive');assert.equal(missing.mtu,null);assert.equal(missing.probes.length,1);
  assert.throws(()=>validateInternetCheck({...mtu,status:'reduced',mtu:1400},'mtu',INTERNET_TARGET));
});
test('latency and capacity findings preserve uncertainty and do not infer actual playback quality',()=>{
  assert.equal(latencySummary(latency(INTERNET_TARGET)).averageMs,40/3);assert.equal(latencySummary(latency(INTERNET_TARGET)).variationMs,10);
  const unavailable=latency(INTERNET_TARGET);unavailable.samples[0]={status:'unavailable',rttMs:null};assert.equal(latencySummary(unavailable).lossPercent,null);
  const value=report([], [unavailable,{kind:'transfer',status:'byte_cap',bytes:DOWNLOAD_BYTES,durationMs:1000,mbps:DOWNLOAD_BYTES*8/1000000},mtu],'internet');
  const findings=internetFindings(value);assert.ok(findings.some((row)=>row.code.startsWith('latency:')&&row.detail.includes('not proof')));assert.ok(findings.some((row)=>row.code==='stream_capacity'&&row.detail.includes('not observed playback')));
  assert.deepEqual(internetFindings({...value,complete:false}),[]);
  assert.throws(()=>validateInternetCheck({kind:'transfer',status:'byte_cap',bytes:1024,durationMs:1000,mbps:1000},'transfer'));
});
function transferFactory(status:number,chunks:Buffer[],onOptions:(value:Record<string,unknown>)=>void=()=>{}){
  let destroyed=false;
  const factory=((options:Record<string,unknown>,listener:(value:unknown)=>void)=>{
    onOptions(options);const req=new EventEmitter() as EventEmitter&{end:()=>void;destroy:()=>void};req.destroy=()=>{destroyed=true;queueMicrotask(()=>req.emit('close'));};
    req.end=()=>queueMicrotask(()=>{const response=new PassThrough() as PassThrough&{statusCode:number;headers:Record<string,string>};response.statusCode=status;response.headers={};listener(response);
      if(!response.destroyed){for(const chunk of chunks)response.write(chunk);response.end();}});return req;
  }) as unknown as typeof httpsRequest;
  return {factory,destroyed:()=>destroyed};
}
test('capacity transport uses only the fixed HTTPS endpoint, refuses redirects and caps processed bytes',async()=>{
  const redirect=transferFactory(302,[Buffer.alloc(10)],(options)=>{assert.equal(options.hostname,DOWNLOAD_HOST);assert.equal(options.rejectUnauthorized,true);assert.equal(options.method,'GET');assert.equal(options.agent,false);});
  assert.equal((await transferCheck(new AbortController().signal,redirect.factory)).status,'http_error');assert.ok(redirect.destroyed());
  const large=transferFactory(200,[Buffer.alloc(DOWNLOAD_BYTES+1024)]);const result=await transferCheck(new AbortController().signal,large.factory);
  assert.equal(result.bytes,DOWNLOAD_BYTES);assert.equal(result.status,'byte_cap');assert.ok(large.destroyed());assert.equal(result.mbps,null);
});
test('capacity transport closes a pending request on cancellation',async()=>{
  let destroyed=false;const controller=new AbortController();
  const factory=(()=>{const req=new EventEmitter() as EventEmitter&{end:()=>void;destroy:()=>void};req.end=()=>controller.abort();req.destroy=()=>{destroyed=true;queueMicrotask(()=>req.emit('close'));};return req;}) as unknown as typeof httpsRequest;
  const result=await transferCheck(controller.signal,factory);assert.equal(result.status,'unavailable');assert.ok(destroyed);
});
test('unconfirmed probe cleanup disables subsequent Internet and discovery collection',async()=>{
  const transport=fixtureProbes();transport.settings=async()=>{throw new InternetCleanupError('private cleanup detail');};
  const {app,store}=createApp({internetProbes:transport});try{
    const start=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,confirmed:true}}),job=await terminal(store,start.json().job.id);
    assert.equal(job.status,'failed');assert.equal(job.diagnosticReport!.complete,false);assert.equal(JSON.stringify(job).includes('private cleanup detail'),false);
    const next=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...input,requestId:'after-cleanup-error',confirmed:true}});assert.equal(next.statusCode,503);
    assert.match((await app.inject({url:'/api/v1/snapshot',headers})).json().collectionError,/cleanup/);
  }finally{await app.close();}
});
test('shutdown aborts and awaits an in-flight configuration read before closing the app',async()=>{
  let started=false,stopped=false;
  const {app}=createApp({readDiagnosticOptions:async(signal)=>{
    started=true;await new Promise<void>((_resolve,reject)=>signal?.addEventListener('abort',()=>void delay(80).then(()=>{stopped=true;reject(new Error('private config detail'));}),{once:true}));
    return {source:'Controlled configuration',resolvers:[],interfaces:[],gateway:null};
  }});
  const response=app.inject({url:'/api/v1/diagnostics/options',headers}).then((value)=>value);
  const until=Date.now()+2000;while(!started&&Date.now()<until)await delay(5);assert.ok(started);
  await app.close();assert.ok(stopped);assert.equal((await response).body.includes('private config detail'),false);
});
test('native local interface metadata is readable without public probes and unknown DHCP stays explicit',async()=>{
  const value=await internetSettings(AbortSignal.timeout(6000));validateInternetCheck(value,'settings');
  if(['win32','linux'].includes(process.platform))assert.equal(value.status,'read');else assert.equal(value.status,'unavailable');
  for(const row of value.interfaces){assert.ok(row.mtu>=68&&row.mtu<=65535);if(process.platform==='win32'&&row.family===6)assert.equal(row.dhcp,null);}
});
