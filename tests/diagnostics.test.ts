import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {createSocket} from 'node:dgram';
import {Resolver} from 'node:dns/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Worker} from 'node:worker_threads';
import {Store} from '../server/store.js';
import {createApp} from '../server/app.js';
import {DiagnosticRunner,parseDiagnostic,diagnosticHostname,validateDiagnosticResult,type createDiagnosticWorker} from '../server/diagnostics.js';
import {diagnosticFindings,connectionAddressProblem} from '../shared/diagnostics.js';
import {parseDiagnosticDns} from '../server/diagnostic-options.js';
import {dnsCheck,connectionCheck} from '../server/diagnostic-network.mjs';
import type {DiagnosticPlan,DiagnosticReport,DnsCheck,ConnectionCheck,Job} from '../shared/types.js';

const headers={host:'127.0.0.1:4318','x-neo-client':'local-ui'};
const body={kind:'dns',requestId:'dns-test-request',hostname:'cloud.example',resolvers:['192.0.2.53'],systemLookup:false};
const dns=(recordType:'A'|'AAAA',status:DnsCheck['status']='answer'):DnsCheck=>({kind:'dns',source:'192.0.2.53',recordType,status,durationMs:10,
  answers:status==='answer'?[{address:recordType==='A'?'192.0.2.1':'2001:db8::1',family:recordType==='A'?4:6,ttl:60}]:[]});
const report=(extra:Partial<DiagnosticReport>={}):DiagnosticReport=>({complete:true,kind:'dns',hostname:'cloud.example',vantage:'Controlled fixture',
  startedAt:Date.now(),updatedAt:Date.now(),dns:[dns('A'),dns('AAAA')],connections:[],findings:[],...extra});
function seed(store:Store,extra:Partial<DiagnosticReport>={}){
  const {spec}=parseDiagnostic(body,store);
  const job:Job={id:'dns-source-job',requestId:body.requestId,spec,synthetic:false,status:'completed',createdAt:Date.now(),startedAt:Date.now(),finishedAt:Date.now(),
    completedTargets:1,totalTargets:1,cyclesCompleted:1,observationsAdded:0,errors:[],diagnosticReport:report(extra)};
  store.saveJob(job);return job;
}
function fakeWorker(results:(DnsCheck|ConnectionCheck)[],options:{delayMs?:number;cleanupMs?:number;forged?:boolean;late?:boolean;omitDone?:boolean}={}){
  let stopped=false,created=0;
  const factory=((data:{attemptId:string})=>{
    created++;
    const worker=new EventEmitter() as EventEmitter&{stdout:{resume:()=>void};stderr:{resume:()=>void};terminate:()=>Promise<number>;unref:()=>void};
    worker.stdout={resume(){}};worker.stderr={resume(){}};worker.unref=()=>{};
    worker.terminate=async()=>{await delay(options.cleanupMs??0);stopped=true;return 0;};
    setTimeout(()=>{
      results.forEach((result,index)=>worker.emit('message',JSON.stringify({v:1,attemptId:options.forged?'forged':data.attemptId,type:'result',index,result})));
      if(!options.omitDone)worker.emit('message',JSON.stringify({v:1,attemptId:data.attemptId,type:'done',count:results.length}));
      if(options.late)setTimeout(()=>worker.emit('message',JSON.stringify({v:1,attemptId:data.attemptId,type:'result',index:0,result:results[0]})),30);
    },options.delayMs??10);
    return worker as unknown as Worker;
  }) as unknown as typeof createDiagnosticWorker;
  return {factory,stopped:()=>stopped,created:()=>created};
}
async function terminal(store:Store,id:string){
  const stop=Date.now()+2000;while(Date.now()<stop){const job=store.job(id)!;if(!['queued','running'].includes(job.status))return job;await delay(5);}
  throw new Error('Diagnostic did not finish');
}
test('DNS scope is strict, exact and requires new explicit consent',()=>{
  const store=new Store();try{
    assert.equal(diagnosticHostname('Cloud.Example.'),'cloud.example');
    for(const hostname of ['localhost','printer.local','http://cloud.example','user@cloud.example','cloud.example/path','bad\n.example','127.0.0.1'])
      assert.throws(()=>parseDiagnostic({...body,hostname},store));
    for(const resolvers of [[],['1.1.1.1:53'],['::'],['fe80::1'],['fe80::1%eth0'],['192.0.2.53','192.0.2.53'],['a','b','c','d']])
      assert.throws(()=>parseDiagnostic({...body,resolvers},store));
    assert.throws(()=>parseDiagnostic({...body,url:'http://elsewhere'},store));
    assert.throws(()=>parseDiagnostic(body,store,true));
    assert.throws(()=>parseDiagnostic({...body,confirmed:'true'},store,true));
    assert.deepEqual(parseDiagnostic({...body,resolvers:['2001:db8::53'],confirmed:true},store,true).plan,
      {kind:'dns',hostname:'cloud.example',resolvers:['2001:db8::53'],systemLookup:false});
  }finally{store.close();}
});
test('connection approval is bound to fresh saved DNS evidence and selected exact addresses',()=>{
  const store=new Store();try{
    seed(store);
    const input={kind:'connect',requestId:'connect-test-id',dnsJobId:'dns-source-job',addresses:['2001:db8::1','192.0.2.1'],port:443,tls:true};
    assert.equal(parseDiagnostic(input,store).plan.hostname,'cloud.example');
    for(const extra of [{addresses:['198.51.100.1']},{addresses:['::ffff:192.0.2.1']},{addresses:[]},{port:0},{tls:'yes'},{hostname:'other.example'}])
      assert.throws(()=>parseDiagnostic({...input,...extra},store));
    seed(store,{updatedAt:Date.now()-900001});assert.throws(()=>parseDiagnostic(input,store));
    for(const value of ['::1','0:0:0:0:0:ffff:7f00:1','fe80::1','ff02::1','127.0.0.1','169.254.169.254','224.0.0.1'])assert.ok(connectionAddressProblem(value));
  }finally{store.close();}
});
test('Windows DNS configuration retains IPv6 and interface provenance instead of dropping it',()=>{
  const parsed=parseDiagnosticDns(JSON.stringify([{InterfaceAlias:'Test link',ServerAddresses:['192.0.2.53','2001:db8::53','fe80::1','bad']}])) ;
  assert.deepEqual(parsed.map((row)=>[row.address,row.family,row.supported]),[['192.0.2.53',4,true],['2001:db8::53',6,true],['fe80::1',6,false]]);
  assert.throws(()=>parseDiagnosticDns('x'.repeat(65537)));
});
test('findings distinguish IPv4-only DNS, resolver disagreement, OS differences and partial results',()=>{
  const value=report({dns:[dns('A'),dns('AAAA','no_data'),{...dns('A','timeout'),source:'2001:db8::53'},
    {kind:'dns',source:'operating-system',recordType:'system',status:'not_found',durationMs:1,answers:[]}]});
  const codes=diagnosticFindings(value).map((row)=>row.code);
  assert.ok(codes.includes('ipv4_only'));assert.ok(codes.includes('resolver_difference'));assert.ok(codes.includes('system_difference'));
  assert.equal(codes.includes('ipv6_path'),false);assert.deepEqual(diagnosticFindings({...value,complete:false}),[]);
  assert.ok(diagnosticFindings(report({dns:[dns('A','servfail'),dns('AAAA','timeout')]})).some((row)=>row.code==='dns_failed'));
});
test('a failed IPv6 path differs from TLS identity failure and successful transport is not application health',()=>{
  const v4:ConnectionCheck={kind:'connect',address:'192.0.2.1',family:4,port:443,sourceAddress:'192.0.2.10',tcp:'connected',tls:'verified',durationMs:1};
  const v6:ConnectionCheck={...v4,address:'2001:db8::1',family:6,tcp:'unreachable',tls:'not_reached',sourceAddress:null};
  const codes=diagnosticFindings(report({kind:'connect',dns:[],connections:[v4,v6]})).map((row)=>row.code);assert.ok(codes.includes('ipv6_path'));
  const cert=diagnosticFindings(report({kind:'connect',dns:[],connections:[v4,{...v6,tcp:'connected',tls:'certificate_error'}]}));
  assert.ok(cert.some((row)=>row.code==='tls_identity'));assert.equal(cert.some((row)=>row.code==='ipv6_path'),false);
  assert.ok(diagnosticFindings(report({kind:'connect',connections:[v4]}))[0].detail.includes('WebDAV'));
});
test('worker results enforce expected resolver, address family, TTLs, result bounds and redaction',()=>{
  const plan:DiagnosticPlan={kind:'dns',hostname:'cloud.example',resolvers:['192.0.2.53'],systemLookup:false};
  assert.equal(validateDiagnosticResult(dns('A'),plan,0).kind,'dns');
  for(const value of [{...dns('A'),source:'198.51.100.53'},{...dns('A'),answers:[{address:'::1',family:6,ttl:10}]},
    {...dns('A'),status:'timeout'},{...dns('A'),secret:'do-not-store'},{...dns('A'),answers:Array(17).fill(dns('A').answers[0])}])
    assert.throws(()=>validateDiagnosticResult(value,plan,0));
});
test('diagnostic previews send no probes, submissions are idempotent and share collection capacity',async()=>{
  const worker=fakeWorker([dns('A'),dns('AAAA')],{delayMs:80,late:true});
  const {app,store}=createApp({diagnosticWorkerFactory:worker.factory});
  try{
    const inject=(path:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/v1/diagnostics/'+path,headers,payload});
    assert.equal((await inject('preview',body)).statusCode,200);assert.equal(worker.created(),0);
    assert.equal((await inject('jobs',body)).statusCode,400);assert.equal(worker.created(),0);
    const first=await inject('jobs',{...body,confirmed:true});assert.equal(first.statusCode,202);const id=first.json().job.id;
    assert.equal((await inject('jobs',{...body,confirmed:true})).json().job.id,id);
    assert.equal((await inject('jobs',{...body,requestId:'different-request',confirmed:true})).statusCode,409);
    assert.equal((await inject('jobs',{...body,hostname:'other.example',confirmed:true})).statusCode,409);
    const job=await terminal(store,id);assert.equal(job.status,'completed');assert.equal(worker.stopped(),true);
    assert.equal(job.diagnosticReport!.complete,true);assert.equal(job.diagnosticReport!.dns.length,2);
    await delay(50);assert.equal(store.job(id)!.diagnosticReport!.dns.length,2);
    assert.equal(store.assets().length,0);assert.equal((await app.inject({url:'/api/v1/snapshot',headers})).json().jobs.length,1);
  }finally{await app.close();}
});
test('cancelled diagnostics keep partial evidence and reserve the shared slot until worker cleanup',async()=>{
  const worker=fakeWorker([dns('A')],{cleanupMs:60,omitDone:true});
  const {app,store}=createApp({diagnosticWorkerFactory:worker.factory});
  try{
    const start=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...body,confirmed:true}}),id=start.json().job.id;
    const stop=Date.now()+1000;while(!store.job(id)?.diagnosticReport?.dns.length&&Date.now()<stop)await delay(2);
    assert.equal(store.job(id)?.diagnosticReport?.dns.length,1);
    await app.inject({method:'POST',url:'/api/v1/jobs/'+id+'/cancel',headers,payload:{}});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...body,requestId:'second-diagnostic',confirmed:true}})).statusCode,409);
    const job=await terminal(store,id);assert.equal(job.status,'cancelled');assert.equal(job.diagnosticReport!.dns.length,1);
    assert.equal(job.diagnosticReport!.complete,false);assert.deepEqual(job.diagnosticReport!.findings,[]);
  }finally{await app.close();}
});
test('forged worker attempts fail without storing diagnostics and the next job can run',async()=>{
  const worker=fakeWorker([dns('A'),dns('AAAA')],{forged:true});const {app,store}=createApp({diagnosticWorkerFactory:worker.factory});
  try{const response=await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...body,confirmed:true}});
    const job=await terminal(store,response.json().job.id);assert.equal(job.status,'failed');assert.equal(job.diagnosticReport!.dns.length,0);
    assert.equal(JSON.stringify(job).includes('forged'),false);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/diagnostics/jobs',headers,payload:{...body,requestId:'next-after-forged',confirmed:true}})).statusCode,202);
  }finally{await app.close();}
});
test('real DNS A/AAAA transport uses only its explicitly selected isolated resolver and preserves TTLs',async()=>{
  const socket=createSocket('udp4');await new Promise<void>((resolve)=>socket.bind(0,'127.0.0.1',resolve));
  const calls:number[]=[];
  socket.on('message',(query,sender)=>{
    const type=query.readUInt16BE(query.length-4);calls.push(type);
    const header=Buffer.from(query.subarray(0,12));header.writeUInt16BE(0x8180,2);header.writeUInt16BE(1,6);
    const rr=Buffer.alloc(12);rr.writeUInt16BE(0xc00c);rr.writeUInt16BE(type,2);rr.writeUInt16BE(1,4);rr.writeUInt32BE(45,6);
    const data=type===1?Buffer.from([192,0,2,1]):Buffer.from('20010db8000000000000000000000001','hex');rr.writeUInt16BE(data.length,10);
    socket.send(Buffer.concat([header,query.subarray(12),rr,data]),sender.port,sender.address);
  });
  try{
    const factory=()=>{const resolver=new Resolver({timeout:500,tries:1});const address=socket.address();
      const set=resolver.setServers.bind(resolver);resolver.setServers=()=>set(['127.0.0.1:'+address.port]);return resolver;};
    const a=await dnsCheck('cloud.example','192.0.2.53','A',factory),aaaa=await dnsCheck('cloud.example','192.0.2.53','AAAA',factory);
    assert.deepEqual(calls,[1,28]);assert.equal(a.answers[0].ttl,45);assert.equal(aaaa.answers[0].address,'2001:db8::1');assert.equal(aaaa.answers[0].family,6);
  }finally{await new Promise<void>((resolve)=>socket.close(()=>resolve()));}
});
test('real TCP checks isolate IPv4 and IPv6 and send no application payload',async()=>{
  for(const host of ['127.0.0.1','::1']){
    let bytes=0;const server=createServer((socket)=>socket.on('data',(data)=>{bytes+=data.length;}));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});
    const address=server.address();assert.ok(address&&typeof address!=='string');
    try{
      const result=await connectionCheck('cloud.example',host,address.port,false);
      assert.equal(result.tcp,'connected');assert.equal(result.family,host==='::1'?6:4);assert.equal(result.sourceAddress,host);assert.equal(bytes,0);
    }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
  }
});
test('the actual source-mode diagnostic worker performs a bounded loopback-only connection',async()=>{
  const server=createServer();await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const reports:DiagnosticReport[]=[];
  const store=new Store();const job=seed(store);job.spec.diagnostic={kind:'connect',hostname:'cloud.example',dnsJobId:job.id,addresses:['127.0.0.1'],port:address.port,tls:false};
  try{
    assert.equal(await new DiagnosticRunner().run(job,new AbortController().signal,(value)=>reports.push(value)),false);
    assert.equal(reports.at(-1)!.complete,true);assert.equal(reports.at(-1)!.connections[0].tcp,'connected');
  }finally{store.close();await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});

test('restart retains a partial diagnostic report and recovers its unfinished job as interrupted',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neo-diagnostic-restart-')),path=join(directory,'neo.sqlite');
  const original=new Store(path,true);const job=seed(original,{complete:false,dns:[dns('A')],findings:[]});
  original.saveJob({...job,status:'running',finishedAt:null});original.close();
  const {app,store}=createApp({dbPath:path});
  try{
    const recovered=store.job(job.id)!;assert.equal(recovered.status,'interrupted');assert.equal(recovered.diagnosticReport!.dns.length,1);
    assert.equal(recovered.diagnosticReport!.complete,false);assert.equal(store.assets().length,0);
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
