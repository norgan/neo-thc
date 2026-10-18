import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {parseDiscovery} from '../server/discovery-scope.js';
import {discoveryObservation} from '../server/discovery-runner.js';
import {GlancesError} from '../server/glances.js';
import {Store} from '../server/store.js';

async function bounded(pending:Promise<unknown>,message:string) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([pending,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(message)),2500);
    })]);
  } finally {clearTimeout(timer);}
}

test('shutdown closes unused browser connections and incomplete HTTP requests',{timeout:10000},async()=>{
  for(const bytes of ['', 'GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:4318\r\n',
    'POST /api/v1/discovery/preview HTTP/1.1\r\nHost: 127.0.0.1:4318\r\nContent-Length: 50\r\n\r\n{']) {
    const {app}=createApp();
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();assert.ok(address&&typeof address!=='string');
    const accepted=once(app.server,'connection');
    const socket=createConnection({host:'127.0.0.1',port:address.port});
    socket.on('error',()=>{});
    try {
      const [[peer]]=await Promise.all([accepted,once(socket,'connect')]);
      if(bytes){const received=once(peer,'data');socket.write(bytes);await received;}
      await bounded(app.close(),'Local server shutdown exceeded 2.5 seconds');
      assert.equal(app.server.listening,false);
    } finally {socket.destroy();app.server.closeAllConnections();await app.close();}
  }
});

test('shutdown cancels an in-flight HTTP stats read and persists partial data before closing SQLite',{timeout:10000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neo-shutdown-')),path=join(directory,'neo.sqlite');
  const iface={id:'shutdown-link',name:'Test link',address:'192.0.2.10',netmask:'255.255.255.0',cidr:'192.0.2.0/24'};
  let begin!:()=>void,aborted=false;
  const begun=new Promise<void>((resolve)=>{begin=resolve;});
  const {app,store}=createApp({dbPath:path,discoveryInterfaces:()=>[iface],glancesRead:async(_target,section,signal)=>{
    if(section==='/api/4/version')return '4.5.8';
    if(section==='/api/4/system')return {hostname:'shutdown.example'};
    if(section==='/api/4/cpu')return {total:0};
    begin();
    await new Promise<void>((resolve)=>{
      const abort=()=>{aborted=true;resolve();};
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    });
    throw new GlancesError('cancelled');
  }});
  const {plan,spec}=parseDiscovery({requestId:'shutdown-discovery',interfaceId:iface.id,cidr:'192.0.2.1/32',
    methods:['tcp'],ports:[443],confirmScope:true},[iface],true);
  store.saveJob({id:'shutdown-job',requestId:'shutdown-discovery',spec,status:'completed',createdAt:1,startedAt:1,finishedAt:2,
    completedTargets:1,totalTargets:1,cyclesCompleted:1,observationsAdded:1,errors:[]});
  store.ingest([discoveryObservation({address:'192.0.2.1',ports:[{port:443,state:'open'}],
    dns:{state:'not_requested',names:[]},mdns:[],ssdp:[],nbns:false,ttlMs:60000},plan,'shutdown-job')]);
  const id=store.assets()[0].id;
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert.ok(address&&typeof address!=='string');
  const client=request({hostname:'127.0.0.1',port:address.port,path:'/api/v1/assets/'+id+'/glances/read',method:'POST',
    headers:{host:'127.0.0.1:4318','content-type':'application/json','x-neo-client':'local-ui'}},(response)=>response.resume());
  client.on('error',()=>{});
  try {
    client.end(JSON.stringify({requestId:'shutdown-stats-read',scheme:'http',port:61208,confirmed:true}));
    await bounded(begun,'Stats fixture did not reach its cancellable request');
    await bounded(app.close(),'Local server shutdown exceeded 2.5 seconds');
    assert.equal(aborted,true);
    const reopened=new Store(path);
    try {
      assert.equal(reopened.assets().length,1);
      const stats=reopened.stats();assert.equal(stats.length,1);
      assert.equal(stats[0].hostname,'shutdown.example');
      assert.equal(stats[0].cpuPercent,0);
      assert.equal(stats[0].status,'partial');
      assert.ok(stats[0].issues.some((issue)=>issue.code==='cancelled'));
    } finally {reopened.close();}
  } finally {
    client.destroy();app.server.closeAllConnections();await app.close();
    await rm(directory,{recursive:true,force:true});
  }
});
