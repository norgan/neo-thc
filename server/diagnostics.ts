import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import {Worker,type WorkerOptions} from 'node:worker_threads';
import type {DiagnosticPlan,DiagnosticReport,DnsCheck,ConnectionCheck,Job,JobSpec} from '../shared/types.js';
import {canonicalAddress,connectionAddressProblem,diagnosticAddresses,diagnosticFindings} from '../shared/diagnostics.js';
import {RequestError} from './jobs.js';
import type {Store} from './store.js';
import {InternetRunner} from './internet-runner.js';
import {MEDIA_HOSTS,INTERNET_DURATION_MS} from '../shared/internet.js';

function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object');return value as Record<string,unknown>;
}
export function diagnosticHostname(value:unknown):string {
  if(typeof value!=='string'||value.length>254)throw new RequestError(400,'Enter one full hostname, without a URL, path or credentials.');
  const name=value.toLowerCase().replace(/\.$/,'');
  if(name.length>253||!name.includes('.')||isIP(name)||name.split('.').some((label)=>!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(label)))
    throw new RequestError(400,'Enter a full hostname such as cloud.example, without a URL, path or credentials.');
  if(name.endsWith('.local')||name.endsWith('.localhost'))throw new RequestError(400,'.local uses mDNS and .localhost is local-only. This workbench checks unicast DNS names such as home.arpa.');
  return name;
}
export function parseDiagnostic(body:unknown,store:Store,confirm=false):{requestId:string;plan:DiagnosticPlan;spec:JobSpec} {
  let row:Record<string,unknown>;try{row=object(body);}catch{throw new RequestError(400,'Enter diagnostic settings.');}
  const allowed=row.kind==='internet'?['kind','requestId','resolvers','port','gateway','download','confirmed']:
    row.kind==='dns'?['kind','requestId','hostname','resolvers','port','systemLookup','confirmed']:
    ['kind','requestId','dnsJobId','addresses','port','tls','confirmed'];
  if(Object.keys(row).some((key)=>!allowed.includes(key))||typeof row.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(row.requestId))
    throw new RequestError(400,'Diagnostic settings or request ID are invalid.');
  if(row.confirmed!==undefined&&typeof row.confirmed!=='boolean')throw new RequestError(400,'Invalid confirmation.');
  if(confirm&&row.confirmed!==true)throw new RequestError(400,'Review and approve these exact diagnostic operations first.');
  let plan:DiagnosticPlan;
  if(row.kind==='dns'||row.kind==='internet'){
    if(!Array.isArray(row.resolvers)||row.resolvers.length<1||row.resolvers.length>3||row.resolvers.some((value)=>typeof value!=='string'||!isIP(value)||value.includes('%')||/^fe[89ab]|^ff|^::$/i.test(value)))
      throw new RequestError(400,'Select one to three literal IPv4/IPv6 DNS servers. Scoped link-local DNS is not yet supported.');
    const resolvers=row.resolvers.map((value:string)=>canonicalAddress(value)).sort();
    if(new Set(resolvers).size!==resolvers.length)throw new RequestError(400,'Select each resolver only once.');
    const port=row.port===undefined?53:row.port;if(typeof port!=='number'||!Number.isInteger(port)||port<1||port>65535)throw new RequestError(400,'Choose a DNS port from 1 to 65535.');
    if(row.kind==='internet'){
      if(typeof row.download!=='boolean'||row.gateway!==null&&(typeof row.gateway!=='string'||!isIP(row.gateway)||connectionAddressProblem(row.gateway)))throw new RequestError(400,'Choose an optional literal gateway and whether to include the bounded download.');
      plan={kind:'internet',hostname:'YouTube and Netflix',resolvers,port,gateway:row.gateway===null?null:canonicalAddress(row.gateway as string),download:row.download};
    }else{
      const hostname=diagnosticHostname(row.hostname);
      if(typeof row.systemLookup!=='boolean')throw new RequestError(400,'Choose whether to compare operating-system resolution.');
      plan={kind:'dns',hostname,resolvers,port,systemLookup:row.systemLookup};
    }
  }else if(row.kind==='connect'){
    if(typeof row.dnsJobId!=='string')throw new RequestError(400,'Choose a saved DNS diagnosis first.');
    const source=store.job(row.dnsJobId),report=source?.diagnosticReport;
    if(source?.spec.diagnostic?.kind!=='dns'||!report||Date.now()-report.updatedAt>900000)
      throw new RequestError(400,'Run a DNS diagnosis first; returned addresses must be less than 15 minutes old.');
    const approved=diagnosticAddresses(report);
    if(!Array.isArray(row.addresses)||!row.addresses.length||row.addresses.length>4||row.addresses.some((value)=>typeof value!=='string'||!isIP(value)))
      throw new RequestError(400,'Choose one to four exact returned addresses.');
    const addresses=row.addresses.map((value:string)=>canonicalAddress(value)).sort();
    if(new Set(addresses).size!==addresses.length||addresses.some((address)=>!approved.includes(address)||connectionAddressProblem(address)))
      throw new RequestError(400,'Only explicitly selected, supported addresses returned by this DNS diagnosis may be checked.');
    if(typeof row.port!=='number'||!Number.isInteger(row.port)||row.port<1||row.port>65535||typeof row.tls!=='boolean')
      throw new RequestError(400,'Choose one service port (1–65535) and whether to verify TLS.');
    plan={kind:'connect',hostname:report.hostname,dnsJobId:row.dnsJobId,addresses,port:row.port,tls:row.tls};
  }else throw new RequestError(400,'Choose DNS or connection diagnosis.');
  return {requestId:row.requestId,plan,spec:{mode:'initial',scope:['diagnostics:connectivity'],exclusions:[],intervalMs:1000,maxCycles:1,maxDurationMs:plan.kind==='internet'?INTERNET_DURATION_MS:12000,diagnostic:plan}};
}
function operations(plan:DiagnosticPlan):{source:string;recordType:'A'|'AAAA'|'system'}[] {
  return plan.kind==='internet'?MEDIA_HOSTS.flatMap((hostname)=>plan.resolvers.flatMap((source)=>[{hostname,source,recordType:'A' as const},{hostname,source,recordType:'AAAA' as const}])):
    plan.kind==='dns'?[...plan.resolvers.flatMap((source)=>[{source,recordType:'A' as const},{source,recordType:'AAAA' as const}]),
    ...(plan.systemLookup?[{source:'operating-system',recordType:'system' as const}]:[])]:[];
}
export function validateDiagnosticResult(value:unknown,plan:DiagnosticPlan,index:number):DnsCheck|ConnectionCheck {
  const row=object(value);
  if(typeof row.durationMs!=='number'||!Number.isFinite(row.durationMs)||row.durationMs<0||row.durationMs>12000)throw new Error('duration');
  if(plan.kind==='dns'||plan.kind==='internet'){
    const expected=operations(plan)[index];
    if(!expected||row.kind!=='dns'||row.source!==expected.source||row.recordType!==expected.recordType||
      Object.keys(row).some((key)=>!['kind','source','recordType','status','answers','durationMs',...(expected.recordType==='system'?[]:['port']),...(plan.kind==='internet'?['hostname']:[])].includes(key))||
      (expected.recordType!=='system'&&(row.port===undefined?53:row.port)!==(plan.port??53))||(plan.kind==='internet'&&row.hostname!==MEDIA_HOSTS[Math.floor(index/(plan.resolvers.length*2))])||
      !['answer','no_data','nxdomain','not_found','servfail','refused','timeout','cancelled','unavailable','response_cap'].includes(String(row.status))||
      !Array.isArray(row.answers)||row.answers.length>16)throw new Error('dns');
    const answers=row.answers.map((value)=>{
      const answer=object(value),family=typeof answer.address==='string'?isIP(answer.address):0;
      if(Object.keys(answer).some((key)=>!['address','family','ttl'].includes(key))||!family||answer.family!==family||
        (expected.recordType==='A'&&family!==4)||(expected.recordType==='AAAA'&&family!==6)||
        (expected.recordType==='system'?answer.ttl!==null:typeof answer.ttl!=='number'||!Number.isInteger(answer.ttl)||answer.ttl<0||answer.ttl>2147483647))throw new Error('answer');
      return {address:canonicalAddress(answer.address as string),family:family as 4|6,ttl:answer.ttl as number|null};
    });
    if((row.status==='answer')!==!!answers.length)throw new Error('answer_status');
    return {...row,...(expected.recordType==='system'?{}:{port:plan.port??53}),answers} as unknown as DnsCheck;
  }
  if(row.kind!=='connect'||row.address!==plan.addresses[index]||row.family!==isIP(plan.addresses[index])||row.port!==plan.port||
    Object.keys(row).some((key)=>!['kind','address','family','port','sourceAddress','tcp','tls','durationMs'].includes(key))||
    (row.sourceAddress!==null&&(typeof row.sourceAddress!=='string'||!isIP(row.sourceAddress)))||
    !['connected','refused','timeout','unreachable','unavailable'].includes(String(row.tcp))||
    !['verified','certificate_error','handshake_error','timeout','not_requested','not_reached'].includes(String(row.tls))||
    (!plan.tls&&row.tls!=='not_requested')||(plan.tls&&(row.tls==='not_requested'||(row.tcp!=='connected'&&row.tls!=='not_reached')||(row.tcp==='connected'&&row.tls==='not_reached'))))throw new Error('connection');
  return row as unknown as ConnectionCheck;
}
export const createDiagnosticWorker=(data:unknown,options:WorkerOptions)=>new Worker(new URL('./diagnostic-worker.mjs',import.meta.url),{...options,workerData:data});
export class DiagnosticRunner {
  private disabled=false;
  constructor(private readonly workerFactory=createDiagnosticWorker,private readonly internet=new InternetRunner()){}
  get problem(){return this.disabled?'Diagnostic worker cleanup failed. Restart Neo before collecting again.':this.internet.problem;}
  async run(job:Job,signal:AbortSignal,publish:(report:DiagnosticReport)=>void):Promise<boolean>{
    const plan=job.spec.diagnostic;if(!plan||this.disabled)throw new Error('diagnostics_unavailable');
    if(plan.kind==='internet')return this.internet.run(job,signal,publish,validateDiagnosticResult);
    signal.throwIfAborted();
    const report:DiagnosticReport={complete:false,kind:plan.kind,hostname:plan.hostname,vantage:'This Neo collector; operating-system routing',
      startedAt:Date.now(),updatedAt:Date.now(),dns:[],connections:[],findings:[]};
    const update=()=>{report.updatedAt=Date.now();report.findings=diagnosticFindings(report);publish(structuredClone(report));};
    update();
    const attemptId=randomUUID(),expected=plan.kind==='dns'?operations(plan).length:plan.addresses.length;
    const worker=this.workerFactory({v:1,attemptId,plan},{env:{},execArgv:[],stdout:true,stderr:true,
      resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:4}});
    worker.stdout.resume();worker.stderr.resume();
    await new Promise<void>((resolve,reject)=>{
      let settled=false,count=0;
      const finish=async(error:Error|null)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        let cleanup:ReturnType<typeof setTimeout>|undefined;
        try{
          const stopped=await Promise.race([worker.terminate().then(()=>true),new Promise<boolean>((done)=>{cleanup=setTimeout(()=>done(false),1000);})]);
          if(!stopped)throw new Error('cleanup');
        }catch{this.disabled=true;worker.unref();error=new Error('Diagnostic cleanup failed');}
        finally{clearTimeout(cleanup);}
        if(error)reject(error);else resolve();
      };
      const abort=()=>void finish(new Error('Diagnostic cancelled'));
      const timer=setTimeout(()=>void finish(new Error('Diagnostic deadline')),11000);
      signal.addEventListener('abort',abort,{once:true});
      worker.on('message',(raw:unknown)=>{
        if(settled)return;
        try{
          if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)throw new Error('message');
          const message=object(JSON.parse(raw));
          if(message.v!==1||message.attemptId!==attemptId)throw new Error('attempt');
          if(message.type==='result'){
            if(Object.keys(message).some((key)=>!['v','attemptId','type','index','result'].includes(key))||message.index!==count||count>=expected)throw new Error('sequence');
            const result=validateDiagnosticResult(message.result,plan,count++);
            if(result.kind==='dns')report.dns.push(result);else report.connections.push(result);update();
          }else if(message.type==='done'&&Object.keys(message).every((key)=>['v','attemptId','type','count'].includes(key))&&message.count===expected&&count===expected)void finish(null);
          else throw new Error('completion');
        }catch{void finish(new Error('Diagnostic result or storage unavailable'));}
      });
      worker.once('error',()=>void finish(new Error('Diagnostic worker failed')));
      worker.once('exit',()=>{if(!settled)void finish(new Error('Diagnostic worker exited'));});
      if(signal.aborted)abort();
    });
    signal.throwIfAborted();report.complete=true;update();
    return report.dns.some((row)=>!['answer','no_data','nxdomain'].includes(row.status))||report.connections.some((row)=>row.tcp!=='connected'||!['verified','not_requested'].includes(row.tls));
  }
}
