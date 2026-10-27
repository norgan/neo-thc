/**
 * Native engine smoke test. Build first, provision dns-bench 0.14.0, then run:
 *   node scripts/dns-benchmark-smoke.mjs
 * Windows uses tools/dns-bench/dns-bench.exe; other hosts can supply an absolute
 * NEO_DNS_BENCH_PATH or install dns-bench on PATH. Missing engines fail this test.
 * All DNS fixture listeners and selected resolver endpoints are loopback-only.
 */
import assert from 'node:assert/strict';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {DnsBenchmarkRunner} from '../dist/server/server/dns-benchmark-runner.js';

const hostname='benchmark.example';
const answer4='192.0.2.123',answer6='2001:db8::1234';
const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),30_000);
const clients=new Set(),seen=new Map(),fixtureErrors=[];
const tcp4=createServer(socket=>accept(socket,4)),tcp6=createServer(socket=>accept(socket,6));
const udp4=createSocket('udp4'),udp6=createSocket({type:'udp6',ipv6Only:true});
const servers=[tcp4,tcp6],datagrams=[udp4,udp6];

function fixtureFailure(message){fixtureErrors.push(message);controller.abort();}

/** Return only the question and one answer, even when the query includes an EDNS OPT record. */
function reply(query,family,protocol){
  if(query.length<17||query.length>4096||query.readUInt16BE(4)!==1||(query.readUInt16BE(2)&0xf800)!==0)
    throw new Error('Unexpected DNS header');
  let cursor=12;const labels=[];
  while(true){
    if(cursor>=query.length)throw new Error('Truncated DNS question');
    const length=query[cursor++];if(length===0)break;
    if(length>63||cursor+length>query.length)throw new Error('Invalid DNS question label');
    labels.push(query.subarray(cursor,cursor+length).toString('ascii'));cursor+=length;
  }
  if(cursor+4>query.length)throw new Error('Truncated DNS question fields');
  const type=query.readUInt16BE(cursor),recordClass=query.readUInt16BE(cursor+2);cursor+=4;
  if(labels.join('.').toLowerCase()!==hostname||recordClass!==1||(type!==1&&type!==28))
    throw new Error('An unexpected hostname or DNS record type reached the loopback fixture');
  const key=family+':'+protocol+':'+(type===1?'A':'AAAA');seen.set(key,(seen.get(key)??0)+1);
  const header=Buffer.alloc(12);header.writeUInt16BE(query.readUInt16BE(0),0);
  header.writeUInt16BE(0x8080|(query.readUInt16BE(2)&0x0100),2); // QR, RA and the query's RD bit.
  header.writeUInt16BE(1,4);header.writeUInt16BE(1,6); // One question, one answer, no authority/additional records.
  const data=type===1?Buffer.from([192,0,2,123]):Buffer.from('20010db8'+'0000'.repeat(5)+'1234','hex');
  const answer=Buffer.alloc(12);answer.writeUInt16BE(0xc00c,0);answer.writeUInt16BE(type,2);
  answer.writeUInt16BE(1,4);answer.writeUInt32BE(60,6);answer.writeUInt16BE(data.length,10);
  return Buffer.concat([header,query.subarray(12,cursor),answer,data]);
}

function accept(socket,family){
  clients.add(socket);let pending=Buffer.alloc(0);
  socket.once('close',()=>clients.delete(socket));
  socket.on('error',()=>fixtureFailure('A loopback TCP fixture connection failed.'));
  socket.on('data',chunk=>{
    try{
      pending=Buffer.concat([pending,chunk]);if(pending.length>8192)throw new Error('TCP fixture input exceeded its bound');
      while(pending.length>=2){
        const length=pending.readUInt16BE(0);if(length<17||length>4096)throw new Error('Invalid DNS TCP frame');
        if(pending.length<length+2)break;
        const response=reply(pending.subarray(2,length+2),family,'tcp');pending=pending.subarray(length+2);
        const size=Buffer.alloc(2);size.writeUInt16BE(response.length);socket.write(Buffer.concat([size,response]));
      }
    }catch(error){fixtureFailure(error.message);socket.destroy();}
  });
}

for(const [socket,family] of [[udp4,4],[udp6,6]]){
  socket.on('error',()=>fixtureFailure('A loopback UDP fixture failed.'));
  socket.on('message',(query,sender)=>{
    try{
      if(sender.address!==(family===4?'127.0.0.1':'::1'))throw new Error('A non-loopback sender reached the fixture');
      const response=reply(query,family,'udp');
      socket.send(response,sender.port,sender.address,error=>{if(error)fixtureFailure('A loopback DNS reply could not be sent.');});
    }catch(error){fixtureFailure(error.message);}
  });
}
for(const server of servers)server.on('error',()=>fixtureFailure('A loopback TCP listener failed.'));

async function listening(target,start){
  controller.signal.throwIfAborted();
  await new Promise((resolve,reject)=>{
    const abort=()=>finish(new Error('DNS benchmark smoke deadline reached.'));
    const ready=()=>finish(null),failed=()=>finish(new Error('A required loopback listener could not bind.'));
    let settled=false;
    function finish(error){
      if(settled)return;settled=true;
      target.removeListener('listening',ready);target.removeListener('error',failed);controller.signal.removeEventListener('abort',abort);
      if(error)reject(error);else resolve();
    }
    target.once('listening',ready);target.once('error',failed);controller.signal.addEventListener('abort',abort,{once:true});
    try{start();}catch(error){finish(error);}
    if(controller.signal.aborted)abort();
  });
}

function stop(target){
  return new Promise(resolve=>{
    try{target.close(()=>resolve());}catch{resolve();}
  });
}

try{
  await listening(tcp4,()=>tcp4.listen({host:'127.0.0.1',port:0}));
  const port=tcp4.address().port;
  await listening(tcp6,()=>tcp6.listen({host:'::1',port,ipv6Only:true}));
  await listening(udp4,()=>udp4.bind(port,'127.0.0.1'));
  await listening(udp6,()=>udp6.bind(port,'::1'));
  const plan={hostnames:[hostname],resolvers:['127.0.0.1','::1'],port,protocols:['udp','tcp'],recordTypes:['A','AAAA'],requests:2,timeoutSeconds:1};
  const job={id:'native-dns-benchmark-smoke',requestId:'native-dns-benchmark-smoke',synthetic:false,
    spec:{mode:'initial',scope:['diagnostics:dns-benchmark'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:25_000,dnsBenchmark:plan},
    status:'running',createdAt:Date.now(),startedAt:Date.now(),finishedAt:null,completedTargets:0,totalTargets:1,cyclesCompleted:0,observationsAdded:0,errors:[]};
  let report;
  const runner=new DnsBenchmarkRunner();
  const issues=await runner.run(job,controller.signal,value=>{report=value;});
  assert.deepEqual(fixtureErrors,[]);assert.equal(runner.problem,null);assert.equal(issues,false);
  assert.equal(report?.complete,true);assert.equal(report?.toolVersion,'0.14.0');
  assert.equal(report?.totalComparisons,8);assert.equal(report?.results.length,8);
  for(const row of report.results){
    assert.equal(row.status,'complete');assert.equal(row.hostname,hostname);assert.equal(row.port,port);
    assert.equal(row.totalRequests,2);assert.equal(row.successfulRequests,2);assert.equal(row.successPercent,100);
    assert.equal(row.lastResolvedAddress,row.recordType==='A'?answer4:answer6);
    assert.ok(row.minMs>=0&&row.avgMs>=row.minMs&&row.maxMs>=row.avgMs);
    assert.ok((seen.get(row.family+':'+row.protocol+':'+row.recordType)??0)>=2);
  }
  const expected=[4,6].flatMap(family=>['udp','tcp'].flatMap(protocol=>['A','AAAA'].map(type=>family+':'+protocol+':'+type)));
  assert.deepEqual([...seen.keys()].sort(),expected.sort());
  console.log('Native dns-bench 0.14.0 smoke passed: eight IPv4/IPv6, UDP/TCP and A/AAAA comparisons; two successful requests each, loopback only.');
}catch(error){
  if(fixtureErrors.length)console.error(fixtureErrors.join('\n'));
  throw error;
}finally{
  controller.abort();clearTimeout(deadline);
  for(const socket of clients)socket.destroy();
  await Promise.all([...servers,...datagrams].map(stop));
}
