import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {systemViews,networkFacts} from '../shared/inventory.js';
import type {ObservationInput} from '../shared/types.js';
function evidence(job:string,at:number,extra:Partial<ObservationInput>={}):ObservationInput {
  return {synthetic:false,id:job,subjectKey:job+'/192.0.2.1',label:'Address candidate 192.0.2.1',kind:'address-candidate',
    source:'discovery-v1',vantage:'interface 192.0.2.10',observedAt:at,ttlMs:10000,status:'unknown',
    note:'Real scoped network attempt. Unverified PTR claims: server.example. Identity is this job plus address only; later jobs remain separate.',
    identifiers:[{kind:'ip',value:'192.0.2.1'}],services:[{name:'TCP 443',status:'unknown',note:'Connect result: open. No payload.'}],...extra};
}
test('legacy real evidence yields a friendly PTR name and cautious port suggestions',()=>{
  const store=new Store();
  try {
    store.ingest([evidence('first',1000)],1000);
    const view=systemViews(store.assets())[0];
    assert.equal(view.displayName,'server.example');assert.equal(view.nameBasis,'PTR');assert.equal(view.responded,true);
    assert.deepEqual(view.openPorts,[443]);assert.match(view.services[0].evidence,/TLS and HTTP were not verified/);
    assert.equal(view.roles[0].confidence,'port-hint');
  } finally {store.close();}
});
test('latest address presentation retains independent identities without carrying old names or services',()=>{
  const store=new Store();
  try {
    store.ingest([evidence('first',1000,{network:{address:'192.0.2.1',ptrNames:['old.example'],ptrState:'answer',
      ports:[{port:443,state:'open'}],mdns:['_glances._tcp.local'],ssdp:[],nbns:false}})],1000);
    store.ingest([evidence('second',2000,{network:{address:'192.0.2.1',ptrNames:[],ptrState:'no_data',
      ports:[{port:443,state:'timeout'}],mdns:[],ssdp:[],nbns:false}})],2000);
    const view=systemViews(store.assets())[0];
    assert.equal(store.assets().length,2);assert.equal(view.assetIds.length,2);assert.equal(view.displayName,'Unnamed system');
    assert.equal(view.responded,true);assert.equal(view.respondedLatest,false);assert.equal(view.lastResponseAt,1000);
    assert.deepEqual(view.services,[]);assert.deepEqual(view.openPorts,[]);assert.deepEqual(view.names,['old.example']);
  } finally {store.close();}
});
test('DNS-only claims do not prove a response; advertised monitoring does not invent hardware metrics',()=>{
  const store=new Store();
  try {
    const network={address:'192.0.2.1',ptrNames:['dns-only.example'],ptrState:'answer',ports:[],mdns:[],ssdp:[],nbns:false};
    store.ingest([evidence('dns',1000,{network,services:[]})],1000);
    assert.equal(systemViews(store.assets())[0].responded,false);
    store.ingest([evidence('mdns',2000,{network:{...network,mdns:['_glances._tcp.local']}})],2000);
    const view=systemViews(store.assets())[0];
    assert.equal(view.services[0].name,'Glances');assert.equal(view.roles[0].label,'Monitoring endpoint');
    assert.equal(view.services[0].confidence,'advertised');assert.equal('cpuPercent' in view,false);
    assert.equal(networkFacts({...store.assets()[0].latest!,synthetic:true}),null);
  } finally {store.close();}
});
