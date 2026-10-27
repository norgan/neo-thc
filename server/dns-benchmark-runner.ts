import {spawn,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {subprocessEnvironment} from './subprocess-env.js';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalAddress} from '../shared/diagnostics.js';
import {DNS_BENCH_VERSION,DNS_BENCHMARK_LIMITS,benchmarkComparisons,
  type DnsBenchmarkCapability,type DnsBenchmarkComparison,type DnsBenchmarkPlan,
  type DnsBenchmarkReport,type DnsBenchmarkResult} from '../shared/dns-benchmark.js';
import type {Job} from '../shared/types.js';
import {benchmarkResolverProblem,canonicalDnsAddress} from './diagnostic-options.js';

const RESOLVER_NAME='NEO-THC selected resolver';
const CUSTOM_LIST_PREFIX='Using custom servers list.';
const CLEANUP_PROBLEM='DNS benchmark cleanup was not confirmed. Restart Neo before collecting again.';
const UNAVAILABLE='dns-bench is unavailable. Install the supported 0.14.0 executable on this collector.';
type ProcessFailure='unavailable'|'timed_out'|'invalid_output'|'cancelled'|'cleanup';
class ProcessError extends Error {
  constructor(readonly kind:ProcessFailure){super('DNS benchmark process '+kind);}
}

/** Injection exists for native subprocess tests; HTTP settings cannot choose a program. */
export type DnsBenchmarkSpawn=(file:string,args:string[],options:SpawnOptions)=>ChildProcess;
export interface DnsBenchmarkRunnerOptions {
  executable?:string;
  spawn?:DnsBenchmarkSpawn;
  tempRoot?:string;
  processTimeoutMs?:number;
  versionTimeoutMs?:number;
  maxDurationMs?:number;
  cleanupTimeoutMs?:number;
}

function loweredLimit(value:number|undefined,maximum:number):number {
  if(value===undefined)return maximum;
  if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid DNS benchmark process limit.');
  return Math.min(value,maximum);
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid DNS benchmark output.');
  return value as Record<string,unknown>;
}
function exactKeys(row:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new Error('Invalid DNS benchmark output.');
}
function resolverParts(address:string):{address:string;bare:string;family:4|6} {
  if(typeof address!=='string'||benchmarkResolverProblem(address))throw new Error('Invalid DNS benchmark resolver.');
  const canonical=canonicalDnsAddress(address),bare=canonical.split('%')[0],family=isIP(bare);
  if(family!==4&&family!==6)throw new Error('Invalid DNS benchmark resolver.');
  return {address:canonical,bare,family};
}
function validPlan(plan:DnsBenchmarkPlan|undefined):asserts plan is DnsBenchmarkPlan {
  if(!plan||!Array.isArray(plan.hostnames)||!plan.hostnames.length||plan.hostnames.length>DNS_BENCHMARK_LIMITS.maxHostnames||
    plan.hostnames.some(name=>typeof name!=='string'||name.length>253||!name.includes('.')||isIP(name)||
      name.split('.').some(label=>!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i.test(label)))||
    new Set(plan.hostnames).size!==plan.hostnames.length||!Array.isArray(plan.resolvers)||!plan.resolvers.length||
    plan.resolvers.length>DNS_BENCHMARK_LIMITS.maxResolvers||!Array.isArray(plan.protocols)||!plan.protocols.length||
    plan.protocols.length>2||plan.protocols.some(value=>value!=='udp'&&value!=='tcp')||new Set(plan.protocols).size!==plan.protocols.length||
    !Array.isArray(plan.recordTypes)||!plan.recordTypes.length||plan.recordTypes.length>2||
    plan.recordTypes.some(value=>value!=='A'&&value!=='AAAA')||new Set(plan.recordTypes).size!==plan.recordTypes.length||
    !Number.isInteger(plan.port)||plan.port<1||plan.port>65535||!Number.isInteger(plan.requests)||plan.requests<1||
    plan.requests>DNS_BENCHMARK_LIMITS.maxRequests||!Number.isInteger(plan.timeoutSeconds)||plan.timeoutSeconds<1||
    plan.timeoutSeconds>DNS_BENCHMARK_LIMITS.maxTimeoutSeconds)throw new Error('Invalid DNS benchmark plan.');
  const resolvers=plan.resolvers.map(value=>resolverParts(value).address);
  if(new Set(resolvers).size!==resolvers.length)throw new Error('Duplicate DNS benchmark resolver.');
}
function duration(value:unknown,successful:boolean):number|null {
  const row=object(value);
  if(!successful){exactKeys(row,['failed']);if(row.failed!=='No responses')throw new Error('Invalid DNS benchmark timing.');return null;}
  exactKeys(row,['succeeded']);const data=object(row.succeeded);exactKeys(data,['secs','nanos']);
  if(typeof data.secs!=='number'||!Number.isSafeInteger(data.secs)||data.secs<0||typeof data.nanos!=='number'||
    !Number.isInteger(data.nanos)||data.nanos<0||data.nanos>=1_000_000_000)throw new Error('Invalid DNS benchmark timing.');
  const milliseconds=data.secs*1000+data.nanos/1_000_000;
  if(milliseconds>DNS_BENCHMARK_LIMITS.processTimeoutMs)throw new Error('Invalid DNS benchmark timing.');
  return milliseconds;
}
function emptyResult(plan:DnsBenchmarkPlan,comparison:DnsBenchmarkComparison,status:DnsBenchmarkResult['status'],issue:string):DnsBenchmarkResult {
  return {...comparison,port:plan.port,family:resolverParts(comparison.resolver).family,status,
    totalRequests:null,successfulRequests:null,successPercent:null,minMs:null,avgMs:null,maxMs:null,lastResolvedAddress:null,issue};
}

/** Validate the pinned upstream wire format, without ever retaining untrusted stderr or error strings. */
export function parseDnsBenchmarkOutput(text:string,plan:DnsBenchmarkPlan,comparison:DnsBenchmarkComparison):DnsBenchmarkResult {
  if(Buffer.byteLength(text)>DNS_BENCHMARK_LIMITS.maxOutputBytes)throw new Error('Invalid DNS benchmark output.');
  if(text.startsWith(CUSTOM_LIST_PREFIX+'\r\n'))text=text.slice(CUSTOM_LIST_PREFIX.length+2);
  else if(text.startsWith(CUSTOM_LIST_PREFIX+'\n'))text=text.slice(CUSTOM_LIST_PREFIX.length+1);
  const raw:unknown=JSON.parse(text);
  if(!Array.isArray(raw)||raw.length!==1)throw new Error('Invalid DNS benchmark output.');
  const row=object(raw[0]),resolver=resolverParts(comparison.resolver);
  exactKeys(row,['name','ip','last_resolved_ip','total_requests','successful_requests','successful_requests_percentage','min_duration','avg_duration','max_duration']);
  if(row.name!==RESOLVER_NAME||typeof row.ip!=='string'||row.ip.includes('%')||isIP(row.ip)!==resolver.family||
    canonicalAddress(row.ip)!==resolver.bare||row.total_requests!==plan.requests||typeof row.successful_requests!=='number'||
    !Number.isInteger(row.successful_requests)||row.successful_requests<0||row.successful_requests>plan.requests||
    typeof row.successful_requests_percentage!=='number'||!Number.isFinite(row.successful_requests_percentage)||
    row.successful_requests_percentage<0||row.successful_requests_percentage>100||
    Math.abs(row.successful_requests_percentage-row.successful_requests/plan.requests*100)>0.0001||
    typeof row.last_resolved_ip!=='string'||row.last_resolved_ip.includes('%'))throw new Error('Invalid DNS benchmark output.');
  const successful=row.successful_requests>0,expectedFamily=comparison.recordType==='A'?4:6;
  // v0.14.0 uses 0.0.0.0 as its sentinel even when an AAAA comparison has no responses.
  if(successful?isIP(row.last_resolved_ip)!==expectedFamily:row.last_resolved_ip!=='0.0.0.0')throw new Error('Invalid DNS benchmark answer.');
  const minMs=duration(row.min_duration,successful),avgMs=duration(row.avg_duration,successful),maxMs=duration(row.max_duration,successful);
  if(successful&&(minMs! > avgMs!||avgMs! > maxMs!||(row.successful_requests===1&&(minMs!==avgMs||avgMs!==maxMs))))throw new Error('Invalid DNS benchmark timing.');
  return {...comparison,port:plan.port,family:resolver.family,status:successful?'complete':'no_responses',totalRequests:plan.requests,
    successfulRequests:row.successful_requests,successPercent:row.successful_requests/plan.requests*100,minMs,avgMs,maxMs,
    lastResolvedAddress:successful?canonicalAddress(row.last_resolved_ip):null,
    issue:!successful?'No requests returned an address.':row.successful_requests<plan.requests?'Some requests did not return an address.':null};
}

export class DnsBenchmarkRunner {
  private disabled=false;
  private running=false;
  private readonly executable:string|null;
  private readonly spawnProcess:DnsBenchmarkSpawn;
  private readonly processTimeoutMs:number;
  private readonly versionTimeoutMs:number;
  private readonly maxDurationMs:number;
  private readonly cleanupTimeoutMs:number;
  private readonly tempRoot:string;
  constructor(options:DnsBenchmarkRunnerOptions={}){
    const configured=options.executable??process.env.NEO_DNS_BENCH_PATH;
    this.executable=configured!==undefined?(isAbsolute(configured)?configured:null):process.platform==='win32'
      ?fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../tools/dns-bench/dns-bench.exe':'../../../tools/dns-bench/dns-bench.exe',import.meta.url))
      :'dns-bench';
    this.spawnProcess=options.spawn??spawn;
    this.processTimeoutMs=loweredLimit(options.processTimeoutMs,DNS_BENCHMARK_LIMITS.processTimeoutMs);
    this.versionTimeoutMs=loweredLimit(options.versionTimeoutMs,3000);
    this.maxDurationMs=loweredLimit(options.maxDurationMs,DNS_BENCHMARK_LIMITS.maxDurationMs);
    this.cleanupTimeoutMs=loweredLimit(options.cleanupTimeoutMs,1000);
    this.tempRoot=options.tempRoot??tmpdir();
  }
  get problem():string|null{return this.disabled?CLEANUP_PROBLEM:null;}

  private execute(args:string[],signal:AbortSignal,timeoutMs:number,cwd?:string):Promise<string>{
    if(this.disabled)return Promise.reject(new ProcessError('cleanup'));
    if(signal.aborted)return Promise.reject(new ProcessError('cancelled'));
    if(!this.executable)return Promise.reject(new ProcessError('unavailable'));
    return new Promise<string>((resolve,reject)=>{
      let child:ChildProcess;
      try{child=this.spawnProcess(this.executable!,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:subprocessEnvironment(),...(cwd?{cwd}:{})});}
      catch{reject(new ProcessError('unavailable'));return;}
      let settled=false,failure:ProcessFailure|null=null,bytes=0;
      const output:Buffer[]=[];
      let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
      const finish=(code:number|null)=>{
        if(settled)return;settled=true;clearTimeout(deadline);clearTimeout(cleanupTimer);signal.removeEventListener('abort',abort);
        child.stdout?.removeListener('data',stdout);child.stderr?.removeListener('data',stderr);
        if(failure){reject(new ProcessError(failure));return;}
        if(code!==0){reject(new ProcessError('unavailable'));return;}
        try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output)));}
        catch{reject(new ProcessError('invalid_output'));}
      };
      const stop=(kind:ProcessFailure)=>{
        if(settled||failure)return;failure=kind;clearTimeout(deadline);
        // Cancellation is not complete until close confirms both the process and its pipes ended.
        cleanupTimer=setTimeout(()=>{
          if(settled)return;this.disabled=true;failure='cleanup';
          child.stdout?.destroy();child.stderr?.destroy();child.unref();finish(null);
        },this.cleanupTimeoutMs);
        try{child.kill('SIGKILL');}catch{/* The close event remains the cleanup acknowledgement. */}
      };
      const collect=(chunk:Buffer|string,save:boolean)=>{
        if(settled||failure)return;const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        bytes+=value.byteLength;if(bytes>DNS_BENCHMARK_LIMITS.maxOutputBytes){stop('invalid_output');return;}
        if(save)output.push(value);
      };
      const stdout=(chunk:Buffer|string)=>collect(chunk,true),stderr=(chunk:Buffer|string)=>collect(chunk,false);
      const abort=()=>stop('cancelled');
      const deadline=setTimeout(()=>stop('timed_out'),timeoutMs);
      child.stdout?.on('data',stdout);child.stderr?.on('data',stderr);
      // Keep an error listener after a cleanup timeout so a delayed OS error cannot escape as an unhandled event.
      child.on('error',()=>stop('unavailable'));
      child.once('close',finish);
      signal.addEventListener('abort',abort,{once:true});
      if(!child.stdout||!child.stderr)stop('unavailable');
      if(signal.aborted)abort();
    });
  }

  async capability(signal:AbortSignal=new AbortController().signal):Promise<DnsBenchmarkCapability>{
    if(signal.aborted)throw new Error('DNS benchmark cancelled.');
    if(this.problem)return {available:false,version:null,reason:this.problem};
    try{
      const output=await this.execute(['--version'],signal,this.versionTimeoutMs);
      if(signal.aborted)throw new ProcessError('cancelled');
      const match=/^dns-bench (\d{1,4}\.\d{1,4}\.\d{1,4})\r?\n?$/.exec(output);
      if(!match)return {available:false,version:null,reason:'dns-bench did not return a recognised version.'};
      if(match[1]!==DNS_BENCH_VERSION)return {available:false,version:match[1],reason:'This collector requires dns-bench '+DNS_BENCH_VERSION+'.'};
      return {available:true,version:DNS_BENCH_VERSION,reason:null};
    }catch(error){
      if(signal.aborted||error instanceof ProcessError&&error.kind==='cancelled')throw new Error('DNS benchmark cancelled.');
      return {available:false,version:null,reason:this.problem??(error instanceof ProcessError&&error.kind==='timed_out'
        ?'dns-bench version verification exceeded its time limit.':UNAVAILABLE)};
    }
  }

  async run(job:Job,signal:AbortSignal,publish:(report:DnsBenchmarkReport)=>void):Promise<boolean>{
    const requested=job.spec.dnsBenchmark;validPlan(requested);const plan=structuredClone(requested);
    if(this.problem)throw new Error(this.problem);
    if(this.running)throw new Error('A DNS benchmark is already running.');
    if(signal.aborted)throw new Error('DNS benchmark cancelled.');
    this.running=true;
    const controller=new AbortController(),abort=()=>controller.abort();
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const deadline=setTimeout(abort,Math.min(this.maxDurationMs,job.spec.maxDurationMs));
    const active=controller.signal,comparisons=benchmarkComparisons(plan),startedAt=Date.now();
    const report:DnsBenchmarkReport={complete:false,tool:'dns-bench',toolVersion:DNS_BENCH_VERSION,
      vantage:'This Neo collector; explicitly selected DNS resolvers and operating-system routing',startedAt,updatedAt:startedAt,
      totalComparisons:comparisons.length,results:[]};
    const update=()=>{
      if(active.aborted)throw new Error('DNS benchmark cancelled or deadline reached.');
      report.updatedAt=Date.now();publish(structuredClone(report));
    };
    let directory:string|undefined,cleanupFailed=false,errorMessage='DNS benchmark stopped before completion.';
    try{
      update();const capability=await this.capability(active);
      if(!capability.available){errorMessage=capability.reason??UNAVAILABLE;throw new Error(errorMessage);}
      if(active.aborted)throw new Error('DNS benchmark cancelled or deadline reached.');
      directory=await mkdtemp(join(this.tempRoot,'neo-dns-bench-'));
      await chmod(directory,0o700);
      const results=new Map<number,DnsBenchmarkResult>();let next=0;
      const worker=async()=>{
        try{
          while(next<comparisons.length){
            if(active.aborted)throw new Error('DNS benchmark cancelled or deadline reached.');
            const index=next++,comparison=comparisons[index],resolver=resolverParts(comparison.resolver);
            const path=join(directory!,String(index)+'.txt');
            await writeFile(path,RESOLVER_NAME+';'+(resolver.family===6?'['+resolver.address+']':resolver.address)+':'+plan.port+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
            if(active.aborted)throw new Error('DNS benchmark cancelled or deadline reached.');
            const args=['--custom-servers-file',path,'--skip-system-servers','--skip-gateway-detection','--disable-adaptive-timeout',
              '--domain',comparison.hostname,'--requests',String(plan.requests),'--threads','1','--timeout',String(plan.timeoutSeconds),
              '--protocol',comparison.protocol,'--name-servers-ip',resolver.family===4?'v4':'v6',
              '--lookup-ip',comparison.recordType==='A'?'v4':'v6','--format','json','--style','ascii'];
            let result:DnsBenchmarkResult;
            try{
              const output=await this.execute(args,active,this.processTimeoutMs,directory);
              try{result=parseDnsBenchmarkOutput(output,plan,comparison);}
              catch{result=emptyResult(plan,comparison,'invalid_output','dns-bench returned an invalid or unexpected result.');}
            }catch(error){
              if(active.aborted||this.disabled||error instanceof ProcessError&&(error.kind==='cancelled'||error.kind==='cleanup'))throw error;
              const kind=error instanceof ProcessError?error.kind:'unavailable';
              result=emptyResult(plan,comparison,kind==='timed_out'?'timed_out':kind==='invalid_output'?'invalid_output':'unavailable',
                kind==='timed_out'?'This comparison exceeded its time limit.':kind==='invalid_output'?'dns-bench output exceeded its limit or was invalid.':'This DNS comparison could not be completed.');
            }
            if(active.aborted)throw new Error('DNS benchmark cancelled or deadline reached.');
            results.set(index,result);report.results=[...results].sort(([a],[b])=>a-b).map(([,value])=>value);update();
          }
        }catch{controller.abort();throw new Error('DNS benchmark stopped.');}
      };
      const outcomes=await Promise.allSettled(Array.from({length:Math.min(DNS_BENCHMARK_LIMITS.concurrency,comparisons.length)},()=>worker()));
      if(outcomes.some(outcome=>outcome.status==='rejected')||active.aborted)throw new Error('DNS benchmark stopped before completion.');
      // Every subprocess has closed before its input directory is removed or the report is marked complete.
      try{await rm(directory,{recursive:true,force:true});directory=undefined;}
      catch{cleanupFailed=true;this.disabled=true;throw new Error(CLEANUP_PROBLEM);}
      report.complete=true;update();
      return report.results.some(row=>row.status!=='complete'||row.successfulRequests!==row.totalRequests);
    }catch{
      // Filesystem, process and storage errors may carry local paths or other private details.
      throw new Error(this.problem??errorMessage);
    }finally{
      controller.abort();clearTimeout(deadline);signal.removeEventListener('abort',abort);
      if(directory&&!cleanupFailed){
        // An unacknowledged child may still be reading its input. Preserve the private directory until an operator restarts it.
        if(this.disabled)cleanupFailed=true;
        else try{await rm(directory,{recursive:true,force:true});}
        catch{cleanupFailed=true;this.disabled=true;}
      }
      this.running=false;
      if(cleanupFailed)throw new Error(CLEANUP_PROBLEM);
    }
  }
}
