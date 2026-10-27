import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DnsBenchmarkRunner,parseDnsBenchmarkOutput,type DnsBenchmarkSpawn,type DnsBenchmarkRunnerOptions} from '../server/dns-benchmark-runner.js';
import {benchmarkComparisons,type DnsBenchmarkPlan,type DnsBenchmarkReport} from '../shared/dns-benchmark.js';
import type {Job} from '../shared/types.js';

const fixture=fileURLToPath(new URL('./support/dns-bench-fixture.mjs',import.meta.url));
const plan=(changes:Partial<DnsBenchmarkPlan>={}):DnsBenchmarkPlan=>({hostnames:['cloud.example'],resolvers:['192.0.2.53'],port:5353,
  protocols:['udp'],recordTypes:['A'],requests:3,timeoutSeconds:1,...changes});
function job(value:DnsBenchmarkPlan):Job{return {id:'dns-benchmark-job',requestId:'dns-benchmark-request',synthetic:false,
  spec:{mode:'initial',scope:['diagnostics:dns-benchmark'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:180_000,dnsBenchmark:value},
  status:'running',createdAt:Date.now(),startedAt:Date.now(),finishedAt:null,completedTargets:0,totalTargets:1,cyclesCompleted:0,observationsAdded:0,errors:[]};}
function upstream(value:DnsBenchmarkPlan=plan()){
  return {name:'NEO-THC selected resolver',ip:value.resolvers[0].split('%')[0],last_resolved_ip:'192.0.2.1',
    total_requests:value.requests,successful_requests:value.requests,successful_requests_percentage:100,
    min_duration:{succeeded:{secs:0,nanos:1_000_000}},avg_duration:{succeeded:{secs:0,nanos:2_000_000}},max_duration:{succeeded:{secs:0,nanos:3_000_000}}};
}
async function harness(mode='normal',options:DnsBenchmarkRunnerOptions={}){
  const directory=await mkdtemp(join(tmpdir(),'neo-dns-runner-test-')),trace=join(directory,'trace.jsonl');
  const children:ChildProcess[]=[],closed=new Set<ChildProcess>();let active=0,maxActive=0;
  const factory:DnsBenchmarkSpawn=(_file,args,settings)=>{
    assert.equal(settings.shell,false);assert.equal(settings.windowsHide,true);assert.deepEqual(settings.stdio,['ignore','pipe','pipe']);
    const child=spawn(process.execPath,[fixture,mode,...args],{...settings,env:{...process.env,NEO_DNS_BENCH_TEST_TRACE:trace}});
    children.push(child);active++;maxActive=Math.max(maxActive,active);
    child.once('close',()=>{active--;closed.add(child);});return child;
  };
  const runner=new DnsBenchmarkRunner({...options,executable:process.execPath,tempRoot:directory,spawn:factory});
  return {runner,directory,children,closed,maxActive:()=>maxActive,
    trace:async()=>{try{return (await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);}catch{return []; }},
    cleanup:async()=>{for(const child of children)if(!closed.has(child))child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}};
}

test('pinned JSON parsing validates identity, counts, answer family and tagged durations',()=>{
  const value=plan(),comparison=benchmarkComparisons(value)[0],raw=upstream(value);
  for(const prefix of ['', 'Using custom servers list.\n','Using custom servers list.\r\n']){
    const parsed=parseDnsBenchmarkOutput(prefix+JSON.stringify([raw]),value,comparison);
    assert.equal(parsed.minMs,1);assert.equal(parsed.avgMs,2);assert.equal(parsed.maxMs,3);assert.equal(parsed.successPercent,100);
  }
  for(const change of [{name:'unrequested'},{ip:'192.0.2.99'},{total_requests:2},{successful_requests:4},{successful_requests:1.5},
    {successful_requests_percentage:99},{last_resolved_ip:'2001:db8::1'},{min_duration:{succeeded:{secs:0,nanos:1e9}}},
    {max_duration:{succeeded:{secs:31,nanos:0}}},{avg_duration:{succeeded:{secs:0,nanos:500}}},
    {min_duration:{succeeded:{secs:-1,nanos:0}}},{avg_duration:{failed:'SECRET'}},{secret:'not allowed'}])
    assert.throws(()=>parseDnsBenchmarkOutput(JSON.stringify([{...raw,...change}]),value,comparison));
  for(const text of ['SECRET\n'+JSON.stringify([raw]),JSON.stringify([raw])+'\nSECRET',JSON.stringify([raw,raw]),'[]',JSON.stringify({result:raw})])
    assert.throws(()=>parseDnsBenchmarkOutput(text,value,comparison));
});

test('no responses retain null timings and recognise the upstream IPv4 sentinel for failed AAAA checks',()=>{
  const value=plan({recordTypes:['AAAA']}),comparison=benchmarkComparisons(value)[0],failed={failed:'No responses'};
  const raw={...upstream(value),last_resolved_ip:'0.0.0.0',successful_requests:0,successful_requests_percentage:0,
    min_duration:failed,avg_duration:failed,max_duration:failed};
  const result=parseDnsBenchmarkOutput(JSON.stringify([raw]),value,comparison);
  assert.equal(result.status,'no_responses');assert.equal(result.lastResolvedAddress,null);assert.equal(result.avgMs,null);assert.equal(result.totalRequests,3);
  assert.throws(()=>parseDnsBenchmarkOutput(JSON.stringify([{...raw,min_duration:{succeeded:{secs:0,nanos:0}}}]),value,comparison));
});

test('version capability is exact, repeatable and hides executable paths and raw output',async()=>{
  for(const mode of ['normal','version-unsupported','version-invalid']){
    const h=await harness(mode);
    try{
      const first=await h.runner.capability(),second=await h.runner.capability();
      assert.deepEqual(first,second);assert.equal(first.available,mode==='normal');assert.equal(h.children.length,2);
      assert.equal(h.closed.size,2);assert.equal(h.runner.problem,null);assert.equal(JSON.stringify(first).includes('SECRET'),false);
      assert.equal(first.version,mode==='version-invalid'?null:mode==='normal'?'0.14.0':'0.15.0');
    }finally{await h.cleanup();}
  }
  const missing=new DnsBenchmarkRunner({executable:join(tmpdir(),'neo-no-such-private-program-861ce3')});
  const capability=await missing.capability();assert.equal(capability.available,false);assert.equal(missing.problem,null);
  assert.equal(JSON.stringify(capability).includes('861ce3'),false);
  const relative=new DnsBenchmarkRunner({executable:'relative-private-path'});
  assert.equal((await relative.capability()).available,false);assert.equal(relative.problem,null);
});

test('a real process matrix covers independent resolver family, record type and protocol with at most four concurrent children',async()=>{
  const h=await harness('matrix'),reports:DnsBenchmarkReport[]=[];
  const value=plan({resolvers:['192.0.2.53','2001:db8::53'],protocols:['udp','tcp'],recordTypes:['A','AAAA']});
  try{
    assert.equal(await h.runner.run(job(value),new AbortController().signal,report=>reports.push(report)),false);
    const report=reports.at(-1)!;assert.equal(report.complete,true);assert.equal(report.totalComparisons,8);assert.equal(report.results.length,8);
    assert.deepEqual(report.results.map(({hostname,resolver,protocol,recordType})=>({hostname,resolver,protocol,recordType})),benchmarkComparisons(value));
    assert.equal(report.results.find(row=>row.family===6&&row.recordType==='A')?.lastResolvedAddress,'192.0.2.1');
    assert.equal(report.results.find(row=>row.family===4&&row.recordType==='AAAA')?.lastResolvedAddress,'2001:db8::1');
    assert.equal(reports.length,10);assert.equal(reports[0].results.length,0);assert.equal(reports[0].complete,false);
    assert.equal(h.maxActive(),4);assert.equal(h.closed.size,h.children.length);
    const trace=await h.trace(),inputs=trace.filter(row=>row.event==='input');assert.equal(inputs.length,8);
    assert.equal(trace[0].stage,'version');
    for(const input of inputs){if(process.platform!=='win32'){assert.equal(input.fileMode,0o600);assert.equal(input.directoryMode,0o700);}}
    const calls=trace.filter(row=>row.event==='started'&&row.stage==='comparison').map(row=>row.args as string[]);
    assert.ok(calls.some(args=>args[args.indexOf('--name-servers-ip')+1]==='v6'&&args[args.indexOf('--lookup-ip')+1]==='v4'));
    assert.ok(calls.every(args=>args.includes('--skip-system-servers')&&args.includes('--skip-gateway-detection')&&args.includes('--disable-adaptive-timeout')));
    assert.deepEqual(await readdir(h.directory),['trace.jsonl']);assert.equal(JSON.stringify(reports).includes('Fixture progress'),false);
  }finally{await h.cleanup();}
});

test('numeric link-local scope reaches the child but the bare upstream identity is validated',async()=>{
  const h=await harness(),reports:DnsBenchmarkReport[]=[],value=plan({resolvers:['fe80::53%12'],recordTypes:['AAAA']});
  try{
    assert.equal(await h.runner.run(job(value),new AbortController().signal,row=>reports.push(row)),false);
    assert.equal(reports.at(-1)?.results[0].resolver,'fe80::53%12');assert.equal(reports.at(-1)?.results[0].family,6);
    assert.ok((await h.trace()).some(row=>typeof row.input==='string'&&row.input.includes('[fe80::53%12]:5353')));
    for(const resolver of ['fe80::53','fe80::53%0','fe80::53%4294967296','fe80::53%eth0','2001:db8::53%12','ff02::1%12','::','224.0.0.1',
      '::ffff:192.0.2.53','0.0.0.1','169.254.1.53'])
      await assert.rejects(h.runner.run(job(plan({resolvers:[resolver]})),new AbortController().signal,()=>{}));
  }finally{await h.cleanup();}
});

test('partial DNS success is an issue and failed AAAA measurements do not invent timings',async()=>{
  for(const mode of ['some-responses','no-responses']){
    const h=await harness(mode),reports:DnsBenchmarkReport[]=[];
    try{
      assert.equal(await h.runner.run(job(plan({recordTypes:['AAAA']})),new AbortController().signal,row=>reports.push(row)),true);
      const result=reports.at(-1)!.results[0];assert.equal(reports.at(-1)!.complete,true);
      assert.equal(result.successfulRequests,mode==='some-responses'?2:0);assert.equal(result.avgMs,mode==='some-responses'?2:null);
    }finally{await h.cleanup();}
  }
});

test('invalid output, stdout/stderr caps and process failures remain bounded and redacted',async()=>{
  for(const mode of ['bad-prefix','stdout-cap','stderr-cap','exit']){
    const h=await harness(mode),reports:DnsBenchmarkReport[]=[];
    try{
      assert.equal(await h.runner.run(job(plan()),new AbortController().signal,row=>reports.push(row)),true);
      assert.equal(reports.at(-1)!.results[0].status,mode==='exit'?'unavailable':'invalid_output');
      assert.equal(JSON.stringify(reports).includes('SECRET'),false);assert.equal(h.closed.size,h.children.length);assert.equal(h.runner.problem,null);
    }finally{await h.cleanup();}
  }
});

test('a comparison deadline kills and reaps the native child before returning a timed-out cell',async()=>{
  const h=await harness('hang',{processTimeoutMs:120}),reports:DnsBenchmarkReport[]=[];
  try{
    assert.equal(await h.runner.run(job(plan()),new AbortController().signal,row=>reports.push(row)),true);
    assert.equal(reports.at(-1)!.results[0].status,'timed_out');assert.equal(reports.at(-1)!.complete,true);
    assert.equal(h.closed.size,h.children.length);assert.equal(h.runner.problem,null);assert.deepEqual(await readdir(h.directory),['trace.jsonl']);
  }finally{await h.cleanup();}
});

test('cancelled comparison pools retain completed cells and await every child close before releasing temporary files',async()=>{
  const h=await harness('partial'),reports:DnsBenchmarkReport[]=[],controller=new AbortController();
  try{
    await assert.rejects(h.runner.run(job(plan({protocols:['udp','tcp']})),controller.signal,row=>{
      reports.push(row);if(row.results.length===1)controller.abort();
    }));
    assert.equal(reports.at(-1)!.complete,false);assert.equal(reports.at(-1)!.results.length,1);
    assert.equal(h.closed.size,h.children.length);assert.deepEqual(await readdir(h.directory),['trace.jsonl']);
    for(const child of h.children)if(child.pid)assert.throws(()=>process.kill(child.pid!,0));
    const count=reports.length;await delay(30);assert.equal(reports.length,count);assert.equal(h.runner.problem,null);
  }finally{await h.cleanup();}
});

test('whole-job and version deadlines reap children and never mark an unfinished report complete',async()=>{
  const h=await harness('hang',{maxDurationMs:180,processTimeoutMs:1500}),reports:DnsBenchmarkReport[]=[];
  try{
    await assert.rejects(h.runner.run(job(plan()),new AbortController().signal,row=>reports.push(row)));
    assert.equal(reports.at(-1)!.complete,false);assert.equal(reports.at(-1)!.results.length,0);assert.equal(h.closed.size,h.children.length);
  }finally{await h.cleanup();}
  const version=await harness('version-hang',{versionTimeoutMs:100});
  try{
    assert.equal((await version.runner.capability()).available,false);assert.equal(version.closed.size,1);assert.equal(version.runner.problem,null);
    const controller=new AbortController(),pending=version.runner.capability(controller.signal);setTimeout(()=>controller.abort(),30);
    await assert.rejects(pending,/cancelled/);assert.equal(version.closed.size,2);
  }finally{await version.cleanup();}
});

test('unsupported version prevents all comparisons and missing tools do not disable other collection',async()=>{
  const h=await harness('version-unsupported'),reports:DnsBenchmarkReport[]=[];
  try{
    await assert.rejects(h.runner.run(job(plan()),new AbortController().signal,row=>reports.push(row)));
    assert.equal(h.children.length,1);assert.equal(reports.at(-1)!.complete,false);assert.equal(reports.at(-1)!.results.length,0);assert.equal(h.runner.problem,null);
  }finally{await h.cleanup();}
});

test('publication failure aborts peer processes and redacts storage errors',async()=>{
  const h=await harness('partial');
  try{
    await assert.rejects(h.runner.run(job(plan({protocols:['udp','tcp']})),new AbortController().signal,row=>{
      if(row.results.length)throw new Error('SECRET storage path');
    }),error=>error instanceof Error&&!error.message.includes('SECRET'));
    assert.equal(h.closed.size,h.children.length);assert.equal(h.runner.problem,null);assert.deepEqual(await readdir(h.directory),['trace.jsonl']);
    await assert.rejects(h.runner.run(job(plan()),new AbortController().signal,()=>{throw new Error('SECRET initial storage path');}),
      error=>error instanceof Error&&!error.message.includes('SECRET'));
  }finally{await h.cleanup();}
});

test('unacknowledged process cleanup disables future runs while ordinary failures do not',async()=>{
  let calls=0;
  const factory:DnsBenchmarkSpawn=()=>{
    calls++;const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;unref:()=>void};
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>false;child.unref=()=>{};
    return child as unknown as ChildProcess;
  };
  const runner=new DnsBenchmarkRunner({executable:process.execPath,spawn:factory,versionTimeoutMs:10,cleanupTimeoutMs:15});
  assert.equal((await runner.capability()).available,false);assert.match(runner.problem??'',/cleanup/);
  assert.equal((await runner.capability()).available,false);assert.equal(calls,1);
  await assert.rejects(runner.run(job(plan()),new AbortController().signal,()=>{}),/cleanup/);
});

test('input files are preserved if a comparison process cannot acknowledge cleanup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neo-dns-cleanup-test-'));
  const factory:DnsBenchmarkSpawn=(_file,args)=>{
    const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;unref:()=>void};
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>false;child.unref=()=>{};
    if(args.includes('--version'))setImmediate(()=>{child.stdout.write('dns-bench 0.14.0\n');child.emit('close',0);});
    return child as unknown as ChildProcess;
  };
  const runner=new DnsBenchmarkRunner({executable:process.execPath,spawn:factory,tempRoot:directory,processTimeoutMs:10,cleanupTimeoutMs:15});
  try{
    await assert.rejects(runner.run(job(plan()),new AbortController().signal,()=>{}),/cleanup/);
    const entries=await readdir(directory);assert.equal(entries.length,1);
    assert.match(await readFile(join(directory,entries[0],'0.txt'),'utf8'),/192\.0\.2\.53:5353/);assert.match(runner.problem??'',/cleanup/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
