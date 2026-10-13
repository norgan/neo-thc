import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDiscovery, cidrRange } from '../server/discovery-scope.js';
import { discoveryQuery, parseAdvertisement, readName, MDNS_NAME, SSDP_QUERY, parseSsdp } from '../server/discovery-protocols.mjs';
import { tcpProbe, ptrProbe, advertise, pool } from '../server/discovery-network.mjs';
import { validateResult } from '../server/discovery-result.mjs';
import { discoveryObservation, DiscoveryCollector } from '../server/discovery-runner.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { DiscoveryInterface, ObservationInput, Job } from '../shared/types.js';

const iface: DiscoveryInterface = {id:'test-interface',name:'Synthetic interface',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
const settings = (extra:Record<string,unknown>={}) => ({requestId:'discovery-test-001',interfaceId:iface.id,cidr:'192.0.2.0/28',methods:['tcp'],ports:[80,443],...extra});
const plan = (extra:Record<string,unknown>={}) => parseDiscovery(settings(extra),[iface]).plan;
const headers = {host:'127.0.0.1:4318','x-neo-client':'local-ui'};
const name = (value:string) => Buffer.concat([...value.split('.').map((label) => Buffer.concat([Buffer.from([label.length]),Buffer.from(label)])),Buffer.from([0])]);
function response(method:'mdns'|'nbns', id:number, claim='_http._tcp.local') {
  const query=discoveryQuery(method,id);
  const header=Buffer.alloc(12);
  header.writeUInt16BE(id,0);header.writeUInt16BE(0x8400,2);header.writeUInt16BE(method==='mdns'?1:0,4);header.writeUInt16BE(1,6);
  const data=method==='mdns'?name(claim):Buffer.from([0,0,192,0,2,20]);
  const rr=Buffer.alloc(10);
  rr.writeUInt16BE(method==='mdns'?12:0x20,0);rr.writeUInt16BE(1,2);rr.writeUInt32BE(10,4);rr.writeUInt16BE(data.length,8);
  return Buffer.concat([header,...(method==='mdns'?[query.subarray(12)]:[]),query.subarray(12,-4),rr,data]);
}
const row = () => ({address:'192.0.2.1',ports:[{port:80,state:'timeout'},{port:443,state:'closed'}],dns:{state:'not_requested',names:[]},mdns:[],nbns:false,ssdp:[],ttlMs:60000});
async function terminal(get:()=>Job|undefined) {
  const stop=Date.now()+5000;
  while(Date.now()<stop) { const job=get();if(job&&!['queued','running'].includes(job.status))return job;await delay(10); }
  throw new Error('job did not stop');
}

test('scope accepts an explicit on-link /24 while bounding ports and excluding reserved/self addresses',()=>{
  const p=plan({cidr:iface.cidr,ports:[80,443]});
  assert.equal(p.targets.length,253);assert.equal(p.tcpBudget,506);
  assert.ok(!p.targets.includes(iface.address)&&!p.targets.includes('192.0.2.0')&&!p.targets.includes('192.0.2.255'));
  assert.deepEqual(cidrRange('192.0.2.25/28'),{first:3221226000,last:3221226015,prefix:28,size:16,cidr:'192.0.2.16/28'});
  for(const extra of [{cidr:'192.0.0.0/16'},{cidr:'198.51.100.0/24'},{cidr:'192.0.2.0/24',ports:[1,2,3,4,5]},
    {interfaceId:'stale'},{ports:[80,80]},{ports:[0]},{url:'http://example.com'},{methods:[]},{methods:['icmp']},
    {methods:['ptr'],ports:[],resolver:'8.8.8.8'},{methods:['ptr'],ports:[]},{cidr:'::1/128'}]) {
    assert.throws(()=>parseDiscovery(settings(extra),[iface]));
  }
  assert.throws(()=>parseDiscovery(settings(),[iface],true));
});

test('link-wide methods require the whole unambiguous actual subnet and explicit approval',()=>{
  const input=settings({cidr:iface.cidr,methods:['mdns','nbns'],ports:[],linkScopeConfirmed:true});
  assert.equal(parseDiscovery(input,[iface]).plan.datagramBudget,2);
  for(const extra of [{cidr:'192.0.2.0/25'},{linkScopeConfirmed:false}]) assert.throws(()=>parseDiscovery({...input,...extra},[iface]));
  assert.throws(()=>parseDiscovery(input,[iface,{...iface,id:'overlap',address:'192.0.2.11'}]));
  assert.throws(()=>parseDiscovery(input,[{...iface,netmask:'255.255.0.0',cidr:'192.0.0.0/16'}]));
});

test('fixed mDNS and literal NBNS packets contain only the reviewed queries',()=>{
  const mdns=discoveryQuery('mdns',1234),nbns=discoveryQuery('nbns',2345);
  assert.equal(mdns.readUInt16BE(0),1234);assert.equal(mdns.readUInt16BE(2),0);
  assert.equal(readName(mdns,12).name,MDNS_NAME);assert.equal(mdns.readUInt16BE(mdns.length-4),12);
  assert.equal(nbns.readUInt16BE(2),0x10);assert.equal(nbns.readUInt16BE(nbns.length-4),0x20);
  assert.equal(readName(nbns,12).name.length,32);
  assert.deepEqual(parseAdvertisement('mdns',response('mdns',1234),1234).claims,['_http._tcp.local']);
  assert.deepEqual(parseAdvertisement('nbns',response('nbns',2345),2345).claims,['Legacy NetBIOS browse-master response']);
});

test('untrusted discovery packets reject malformed bounds, names, identity and arbitrary records',()=>{
  const valid=response('mdns',7);
  assert.throws(()=>parseAdvertisement('mdns',valid,8));
  for(const packet of [Buffer.alloc(0),valid.subarray(0,-1),Buffer.concat([valid,Buffer.from([0])]),Buffer.alloc(8193)]) {
    assert.throws(()=>parseAdvertisement('mdns',packet,7));
  }
  const count=Buffer.from(valid);count.writeUInt16BE(65535,6);assert.throws(()=>parseAdvertisement('mdns',count,7));
  const flags=Buffer.from(valid);flags.writeUInt16BE(0x0200,2);assert.throws(()=>parseAdvertisement('mdns',flags,7));
  assert.throws(()=>readName(Buffer.from([0xc0,0]),0));
  assert.throws(()=>readName(Buffer.from([0xc0,255]),0));
  assert.throws(()=>readName(Buffer.from([64,...Array(64).fill(65),0]),0));
  assert.throws(()=>parseAdvertisement('mdns',response('mdns',7,'evil.example'),7));
});

test('TCP real loopback fixture verifies open/refused outcomes and source binding without payloads',async()=>{
  const server=createServer((socket)=>socket.on('data',()=>assert.fail('TCP probe sent application bytes')));
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  try {
    assert.equal(await tcpProbe('127.0.0.1',address.port,'127.0.0.1',new AbortController().signal),'open');
  } finally {await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
  assert.equal(await tcpProbe('127.0.0.1',address.port,'127.0.0.1',new AbortController().signal),'closed');
});

test('TCP timeout and abort destroy sockets; concurrency pool is bounded',async()=>{
  const controller=new AbortController();
  let destroyed=0,source:unknown;
  class Socket extends EventEmitter {destroy(){destroyed++;queueMicrotask(()=>this.emit('close'));return this;}}
  const connect=((options:unknown)=>{source=options;return new Socket();}) as unknown as typeof createConnection;
  const pending=tcpProbe('192.0.2.1',443,iface.address,controller.signal,connect);
  controller.abort();assert.equal(await pending,'error');assert.equal(destroyed,1);
  assert.deepEqual(source,{host:'192.0.2.1',port:443,family:4,localAddress:iface.address});
  assert.equal(await tcpProbe('192.0.2.1',443,iface.address,new AbortController().signal,connect),'timeout');
  let active=0,peak=0;
  await pool(Array.from({length:100},(_,i)=>i),16,async()=>{active++;peak=Math.max(peak,active);await delay(1);active--;});
  assert.equal(peak,16);
});

test('PTR queries use only a selected loopback DNS fixture and never follow returned names',async()=>{
  const dns=createSocket('udp4');let queries=0;
  dns.on('message',(query,sender)=>{
    queries++;
    const header=Buffer.from(query.subarray(0,12));header.writeUInt16BE(0x8180,2);header.writeUInt16BE(1,6);
    const data=name('unverified.example'),rr=Buffer.alloc(10);
    rr.writeUInt16BE(12,0);rr.writeUInt16BE(1,2);rr.writeUInt32BE(10,4);rr.writeUInt16BE(data.length,8);
    dns.send(Buffer.concat([header,query.subarray(12),Buffer.from([0xc0,12]),rr,data]),sender.port,sender.address);
  });
  await new Promise<void>((resolve)=>dns.bind(0,'127.0.0.1',resolve));
  try {
    const answer=await ptrProbe('192.0.2.1','127.0.0.1:'+dns.address().port,'127.0.0.1',new AbortController().signal);
    assert.equal(answer.state,'answer');assert.deepEqual(answer.names,['unverified.example']);assert.equal(queries,1);
  } finally {dns.close();}
});

test('UDP send seam binds explicit source and sends one correct local multicast or broadcast packet',async()=>{
  for(const method of ['mdns','nbns'] as const) {
    const controller=new AbortController();
    const calls:Record<string,unknown>={};let closed=0;
    class Socket extends EventEmitter {
      bind(port:number,address:string,callback:()=>void){calls.bind={port,address};queueMicrotask(callback);return this;}
      setTTL(ttl:number){calls.ttl=ttl;return this;}
      setMulticastTTL(ttl:number){calls.multicastTTL=ttl;return this;}
      setMulticastInterface(address:string){calls.interface=address;return this;}
      setBroadcast(value:boolean){calls.broadcast=value;return this;}
      send(packet:Buffer,port:number,address:string,callback:(error:null)=>void){
        calls.send={port,address};callback(null);
        this.emit('message',response(method,packet.readUInt16BE(0)),{port:method==='mdns'?5353:137,address:'192.0.2.20'});
        controller.abort();
      }
      close(){closed++;return this;}
    }
    const p=plan({cidr:iface.cidr,methods:[method],ports:[],linkScopeConfirmed:true});
    const result=await advertise(method,p,controller.signal,(()=>new Socket()) as unknown as typeof createSocket);
    assert.deepEqual(calls.bind,{port:0,address:iface.address});
    assert.deepEqual(calls.send,{port:method==='mdns'?5353:137,address:method==='mdns'?'224.0.0.251':'192.0.2.255'});
    assert.equal(calls.ttl,method==='mdns'?255:1);assert.equal(result.sent,1);assert.equal(result.found.size,1);assert.ok(closed>=1);
  }
});

test('invalid/out-of-scope datagrams consume the receive cap and never introduce targets',async()=>{
  const p=plan({cidr:iface.cidr,methods:['mdns'],ports:[],linkScopeConfirmed:true});
  let closes=0;
  class Socket extends EventEmitter {
    bind(_port:number,_address:string,callback:()=>void){queueMicrotask(callback);}
    setTTL(){} setMulticastTTL(){} setMulticastInterface(){}
    send(_packet:Buffer,_port:number,_address:string,callback:(error:null)=>void){
      callback(null);for(let i=0;i<300;i++)this.emit('message',Buffer.alloc(1),{address:'198.51.100.9',port:5353});
    }
    close(){closes++;}
  }
  const result=await advertise('mdns',p,new AbortController().signal,(()=>new Socket()) as unknown as typeof createSocket);
  assert.equal(result.capped,true);assert.equal(result.received,256);assert.equal(result.found.size,0);assert.ok(closes>=1);
});

test('candidate evidence is per-job, health unknown and never trusts worker provenance',()=>{
  const p=plan(),input=row();
  for(const extra of [{source:'forged'},{synthetic:true},{observedAt:1},{id:'forged'},{address:'198.51.100.8'}]) {
    assert.throws(()=>validateResult({...input,...extra},p));
  }
  const a=discoveryObservation(input,p,'job-first'),b=discoveryObservation(input,p,'job-second');
  assert.notEqual(a.subjectKey,b.subjectKey);assert.equal(a.synthetic,false);assert.equal(a.status,'unknown');
  assert.ok(a.services.every((service)=>service.status==='unknown'));assert.match(a.note,/firewall/);
  const silent=discoveryObservation({...input,ports:input.ports.map((port)=>({...port,state:'timeout'}))},p,'job-silent');
  assert.match(silent.note,/not a confirmed device/);
  assert.equal(discoveryObservation(input,p,'job-test',true).synthetic,true);
});

test('real fixed worker executes only synthetic transport seam in CI and preserves fixture labels',async()=>{
  const p=plan({cidr:'192.0.2.0/30',ports:[443]});
  const collector=new DiscoveryCollector(true,()=>[iface]);
  const items=await collector.collect('discovery:ipv4',{signal:new AbortController().signal,now:Date.now(),cycle:0,jobId:'worker-discovery-test',discovery:p});
  assert.equal(items.length,p.targets.length);
  assert.ok(items.every((item)=>item.synthetic&&item.source==='discovery-fixture-v1'));
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(collector.collect('discovery:ipv4',{signal:cancelled.signal,now:Date.now(),cycle:0,jobId:'worker-discovery-test',discovery:p}));
  const stale=new DiscoveryCollector(true,()=>[]);
  await assert.rejects(stale.collect('discovery:ipv4',{signal:new AbortController().signal,now:Date.now(),cycle:0,jobId:'worker-discovery-test',discovery:p}));
});

test('API discovery requires explicit confirmation, shares job slot and never accepts transport overrides',async()=>{
  const {app,store}=createApp({discoveryInterfaces:()=>[iface],discoveryAdapter:new DiscoveryCollector(true,()=>[iface])});
  try {
    assert.equal((await app.inject({url:'/api/v1/discovery/options',headers})).json().interfaces.length,1);
    const input=settings({cidr:'192.0.2.0/30'});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/discovery/preview',headers,payload:input})).statusCode,200);
    assert.equal(store.jobs().length,0);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/discovery/jobs',headers,payload:input})).statusCode,400);
    for(const key of ['testMode','url','broadcastAddress','command','token']) {
      assert.equal((await app.inject({method:'POST',url:'/api/v1/discovery/jobs',headers,payload:{...input,confirmScope:true,[key]:'bad'}})).statusCode,400);
    }
    const start=await app.inject({method:'POST',url:'/api/v1/discovery/jobs',headers,payload:{...input,confirmScope:true}});
    assert.equal(start.statusCode,202);
    const overlap=await app.inject({method:'POST',url:'/api/v1/jobs',headers,payload:{requestId:'overlap-fixture-job',mode:'initial',scope:['fixture:nas']}});
    assert.equal(overlap.statusCode,409);
    const job=await terminal(()=>store.job(start.json().job.id));
    assert.equal(job.status,'completed');assert.equal(job.discoveryProgress!.addressesCompleted,3);
    assert.equal(store.assets().length,3);assert.ok(store.assets().every((asset)=>asset.latest!.synthetic===true));
    const again=await app.inject({method:'POST',url:'/api/v1/discovery/jobs',headers,payload:{...input,confirmScope:true}});
    assert.equal(again.statusCode,200);assert.equal(again.json().job.id,job.id);
  } finally {await app.close();}
});

test('SSDP uses one fixed root-device request and discards arbitrary LOCATION metadata',async()=>{
  const packet=Buffer.from('HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\nUSN: uuid:00000000-0000-0000-0000-000000000001::upnp:rootdevice\r\nCACHE-CONTROL: max-age=1\r\nLOCATION: http://198.51.100.8/secret\r\n\r\n');
  const parsed=parseSsdp(packet);
  assert.equal(parsed.ttlMs,1000);
  assert.equal(parseSsdp(Buffer.from(packet.toString().replace('max-age=1','max-age=1800'))).ttlMs,10000);
  for(const expiry of ['max-age=0','max-age=-1','max-age=invalid','max-age=','invalid']) {
    assert.throws(()=>parseSsdp(Buffer.from(packet.toString().replace('max-age=1',expiry))));
  }
  assert.throws(()=>parseSsdp(Buffer.from(packet.toString().replace('CACHE-CONTROL: max-age=1\r\n',''))));
  assert.ok(!JSON.stringify(parsed).includes('LOCATION')&&!JSON.stringify(parsed).includes('198.51.100'));
  assert.throws(()=>parseSsdp(Buffer.from('HTTP/1.1 200 OK\r\nST: other\r\n\r\n')));
  assert.throws(()=>parseSsdp(Buffer.concat([packet,Buffer.from('body')])));
  assert.match(SSDP_QUERY.toString(),/ST: upnp:rootdevice/);
  const controller=new AbortController(),calls:unknown[]=[];
  class Socket extends EventEmitter {
    bind(port:number,address:string,callback:()=>void){calls.push({bind:port,address});queueMicrotask(callback);}
    setTTL(value:number){calls.push({ttl:value});} setMulticastTTL(value:number){calls.push({multicastTTL:value});}
    setMulticastInterface(address:string){calls.push({source:address});}
    send(query:Buffer,port:number,address:string,callback:(error:null)=>void) {
      assert.deepEqual(query,SSDP_QUERY);calls.push({port,address});callback(null);
      this.emit('message',packet,{port:49152,address:'192.0.2.20'});controller.abort();
    }
    close(){calls.push('closed');}
  }
  const p=plan({cidr:iface.cidr,methods:['ssdp'],ports:[],linkScopeConfirmed:true});
  const result=await advertise('ssdp',p,controller.signal,(()=>new Socket()) as unknown as typeof createSocket);
  assert.equal(result.sent,1);assert.equal(result.found.size,1);
  assert.ok(calls.some((call)=>JSON.stringify(call)===JSON.stringify({port:1900,address:'239.255.255.250'})));
  assert.ok(calls.includes('closed'));
});

test('detail and inventory APIs never mark network-tagged evidence synthetic',async()=>{
  const {app,store}=createApp({discoveryInterfaces:()=>[iface]});
  try {
    // Simulated network result tests the public provenance contract; no sockets are used.
    store.ingest([discoveryObservation(row(),plan(),'provenance-test-job')]);
    const assets=(await app.inject({url:'/api/v1/assets',headers})).json();
    assert.equal(assets.synthetic,false);
    const detail=(await app.inject({url:'/api/v1/assets/'+assets.assets[0].id,headers})).json();
    assert.equal(detail.synthetic,false);assert.equal(detail.observations[0].synthetic,false);
    assert.equal(detail.asset.latest.source,'discovery-v1');
  } finally {await app.close();}
});

test('advertisement expiry is anchored to host attempt start, never delayed batch delivery',()=>{
  const p=plan({cidr:iface.cidr,methods:['mdns','ssdp'],ports:[],linkScopeConfirmed:true});
  const store=new Store();
  try {
    for(const ttlMs of [1000,10000]) {
      const input={...row(),ports:[],mdns:['_http._tcp.local'],ssdp:['uuid:00000000-0000-0000-0000-000000000001::upnp:rootdevice'],ttlMs};
      const observation=discoveryObservation(input,p,'delayed-'+ttlMs,false,1000);
      assert.equal(observation.observedAt,1000);assert.equal(observation.ttlMs,ttlMs);
      store.ingest([observation],31000);
    }
    assert.ok(store.assets(31000).every((asset)=>asset.freshness==='stale'&&asset.health==='unknown'));
    assert.ok(store.assets(31000).every((asset)=>asset.latest!.receivedAt===31000&&asset.latest!.observedAt===1000));
  } finally {store.close();}
});

test('running discovery cancellation preserves one partial batch and waits for slot cleanup',async()=>{
  const collector=new DiscoveryCollector(true,()=>[iface],'hold-after-first');
  const {app,store,jobs}=createApp({discoveryInterfaces:()=>[iface],discoveryAdapter:collector});
  try {
    const {spec}=parseDiscovery(settings({cidr:'192.0.2.0/30',confirmScope:true}),[iface],true);
    const started=jobs.start('cancel-running-discovery',spec);
    const deadline=Date.now()+5000;
    while(store.observationCount()===0&&Date.now()<deadline)await delay(5);
    assert.equal(store.observationCount(),1);assert.equal(store.job(started.id)!.status,'running');
    jobs.cancel(started.id);jobs.cancel(started.id);
    assert.throws(()=>jobs.start('while-worker-terminates',spec),/Another collection/);
    const stopped=await terminal(()=>store.job(started.id));
    assert.equal(stopped.status,'cancelled');assert.equal(stopped.observationsAdded,1);
    const saved=JSON.stringify({job:store.job(started.id),assets:store.assets()});
    await delay(80);
    assert.equal(JSON.stringify({job:store.job(started.id),assets:store.assets()}),saved);
    const later=jobs.start('fixture-after-discovery',{mode:'initial',scope:['fixture:nas'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:5000});
    assert.equal((await terminal(()=>store.job(later.id))).status,'completed');
    assert.equal(store.assets().filter((asset)=>asset.latest!.source==='discovery-fixture-v1').length,1);
    assert.equal(store.observationCount(),2);
  } finally {await app.close();}
});

test('discovery hard deadline terminates pending worker before its slot can be reused',async()=>{
  const p=plan({cidr:'192.0.2.0/30',ports:[443]});
  const collector=new DiscoveryCollector(true,()=>[iface],'hold-after-first');
  const accepted:ObservationInput[]=[];
  const context={now:Date.now(),cycle:0,jobId:'deadline-discovery',discovery:p,timeoutMs:1000};
  await assert.rejects(collector.collect('discovery:ipv4',{...context,signal:new AbortController().signal,onBatch:(items)=>accepted.push(...items)}),/deadline/);
  assert.equal(accepted.length,1);assert.equal(collector.problem,null);
  const controller=new AbortController();
  await assert.rejects(collector.collect('discovery:ipv4',{...context,jobId:'after-deadline-discovery',signal:controller.signal,
    onBatch:(items)=>{accepted.push(...items);controller.abort();}}),/cancelled/);
  assert.equal(accepted.length,2);assert.equal(collector.problem,null);
  await delay(40);assert.equal(accepted.length,2);
});

test('queued nonempty batches and progress after terminal discovery completion are ignored',async()=>{
  const p=plan({cidr:'192.0.2.0/30',ports:[443]});
  const collector=new DiscoveryCollector(true,()=>[iface],'late-after-done');
  const accepted:ObservationInput[]=[];let progressCount=0;
  for(const jobId of ['late-first-job','late-second-job']) {
    await assert.rejects(collector.collect('discovery:ipv4',{now:Date.now(),cycle:0,jobId,discovery:p,signal:new AbortController().signal,
      onBatch:(items)=>accepted.push(...items),onProgress:()=>{progressCount++;}}),/incomplete/);
  }
  await delay(40);
  assert.equal(accepted.length,2);assert.equal(progressCount,2);
  assert.ok(accepted.every((item)=>item.identifiers[0].value===p.targets[0]));
  assert.notEqual(accepted[0].subjectKey,accepted[1].subjectKey);
});
