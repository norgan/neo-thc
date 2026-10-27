import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkResolverProblem,canonicalDnsAddress,diagnosticOptions,dnsResolverProblem,mergeDiagnosticDns,parseDiagnosticDns} from '../server/diagnostic-options.js';
import type {InternetCheck} from '../shared/types.js';

const unavailableSettings:Extract<InternetCheck,{kind:'settings'}>={kind:'settings',status:'unavailable',gateway:null,interfaces:[]};
const windowsRows=JSON.stringify([
  {InterfaceAlias:'Ethernet',ServerAddresses:['2001:0db8:0:0:0:0:0:53','fd00::53','192.0.2.53','fe80::1%12']},
  {InterfaceAlias:'Ethernet',ServerAddresses:['2001:db8::53','192.0.2.53']},
  {InterfaceAlias:'VPN',ServerAddresses:['2001:db8::53','198.51.100.53']},
]);

test('Windows structured DNS parsing retains IPv6-first, ULA, scoped and subsequent IPv4 evidence',()=>{
  const rows=parseDiagnosticDns('\uFEFF'+windowsRows);
  assert.deepEqual(rows.map(row=>[row.interface,row.address,row.family,row.supported]),[
    ['Ethernet','2001:db8::53',6,true],['Ethernet','fd00::53',6,true],['Ethernet','192.0.2.53',4,true],
    ['Ethernet','fe80::1%12',6,false],['VPN','2001:db8::53',6,true],['VPN','198.51.100.53',4,true],
  ]);
  assert.match(rows.find(row=>row.address==='fe80::1%12')!.reason!,/interface-aware/);
  assert.equal(canonicalDnsAddress('FE80:0:0:0:0:0:0:1%12'),'fe80::1%12');
  assert.equal(canonicalDnsAddress('fe80::1%0012'),'fe80::1%12');
  assert.equal(mergeDiagnosticDns(['fe80::1%0012','fe80::1%12'],[]).length,1);
});

test('resolver merge deduplicates equivalent IPv6 addresses and keeps all interface labels',()=>{
  const rows=mergeDiagnosticDns(['2001:db8::53','192.0.2.53','2001:0db8::53'],parseDiagnosticDns(windowsRows));
  assert.deepEqual(rows.map(row=>row.address),['2001:db8::53','192.0.2.53','fd00::53','fe80::1%12','198.51.100.53']);
  assert.equal(rows[0].interface,'Ethernet, VPN');
  assert.equal(rows[1].interface,'Ethernet');
  assert.equal(rows[3].supported,false);
  assert.match(rows[3].reason!,/interface-aware/);
  assert.equal(mergeDiagnosticDns(Array.from({length:12},(_,index)=>`192.0.2.${index+1}`),[]).length,12);
});

test('empty or failed system-wide discovery retains Windows IPv4 and IPv6 adapter DNS',async()=>{
  for(const systemServers of [()=>[],()=>{throw new Error('Synthetic discovery unavailable');}]){
    const options=await diagnosticOptions(new AbortController().signal,{
      platform:'win32',systemServers,interfaces:()=>({}),readWindowsDns:async()=>windowsRows,
      readSettings:async()=>unavailableSettings,
    });
    assert.deepEqual(options.resolvers.map(row=>row.address),['2001:db8::53','fd00::53','192.0.2.53','fe80::1%12','198.51.100.53']);
    assert.match(options.source,/Windows IPv4 and IPv6 interface DNS configuration/);
    assert.equal(options.gateway,null);
  }
});

test('failed Windows read preserves available OS resolver list; empty discovery is labelled as uncertainty',async()=>{
  const options=await diagnosticOptions(new AbortController().signal,{
    platform:'win32',systemServers:()=>['2001:db8::53','127.0.0.1'],interfaces:()=>({}),
    readWindowsDns:async()=>{throw new Error('Synthetic configuration unavailable');},readSettings:async()=>unavailableSettings,
  });
  assert.deepEqual(options.resolvers.map(row=>[row.address,row.supported]),[['2001:db8::53',true],['127.0.0.1',true]]);
  assert.match(options.source,/interface read unavailable/);
  const empty=await diagnosticOptions(new AbortController().signal,{
    platform:'win32',systemServers:()=>[],interfaces:()=>({}),readWindowsDns:async()=>null,readSettings:async()=>unavailableSettings,
  });
  assert.equal(empty.resolvers.length,0);
  assert.match(empty.source,/no resolver addresses detected/);
  assert.doesNotMatch(empty.source,/no DNS servers configured/);
});

test('DNS benchmark supports explicit numeric IPv6 link scopes without inventing an interface',()=>{
  for(const address of ['2001:db8::53','fd00::53','::1','127.0.0.1','192.0.2.53','fe80::1%12','fe80::1%4294967295'])
    assert.equal(benchmarkResolverProblem(address),null,address);
  for(const address of ['fe80::1','fe80::1%Ethernet','fe80::1%0','fe80::1%4294967296','fd00::53%12','::','::ffff:192.0.2.53','ff02::1','0.0.0.0','0.2.3.4','169.254.1.1','224.0.0.1','resolver.example','[2001:db8::53]:5353'])
    assert.ok(benchmarkResolverProblem(address),address);
  assert.ok(dnsResolverProblem('fe80::1%12'),'The original direct-DNS workbench keeps its separate scope limitation.');
});

test('configuration bounds and cancellation remain enforced without DNS traffic',async()=>{
  assert.throws(()=>parseDiagnosticDns('x'.repeat(65537)));
  assert.throws(()=>parseDiagnosticDns(JSON.stringify(Array.from({length:129},()=>({})))));
  const controller=new AbortController();controller.abort();let called=false;
  await assert.rejects(diagnosticOptions(controller.signal,{readWindowsDns:async()=>{called=true;return null;}}));
  assert.equal(called,false);
});
