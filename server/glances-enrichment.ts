import {randomUUID} from 'node:crypto';
import {Worker,type WorkerOptions} from 'node:worker_threads';
import {isIPv4} from 'node:net';
import type {Job,DiscoveryPlan,GlancesResolution,GlancesEnrichment,GlancesCandidate} from '../shared/types.js';
import {Store} from './store.js';
import {localInterfaces,parseDiscovery} from './discovery-scope.js';
import {readGlances,glancesRequest} from './glances.js';
const codes=['cancelled','socket_error','response_cap','record_cap','no_advertisements','endpoint_cap'];
const candidateCodes=['cancelled','conflict','unresolved','rpc_only','protocol_unknown','address_mismatch','expired'];
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid resolution');return value as Record<string,unknown>;
}
export function validateResolution(value:unknown,plan:DiscoveryPlan):GlancesResolution{
  const row=object(value);
  if(Object.keys(row).some((key)=>!['candidates','datagramsSent','packetsReceived','omitted','issues'].includes(key)))throw new Error('Invalid resolution');
  for(const [key,max] of [['datagramsSent',7],['packetsReceived',257],['omitted',256]] as const)
    if(typeof row[key]!=='number'||!Number.isInteger(row[key])||row[key]<0||row[key]>max)throw new Error('Invalid resolution');
  if(!Array.isArray(row.issues)||row.issues.length>codes.length||row.issues.some((code)=>!codes.includes(code)))throw new Error('Invalid resolution');
  if(!Array.isArray(row.candidates)||row.candidates.length>2)throw new Error('Invalid resolution');
  const candidates:GlancesCandidate[]=row.candidates.map((item)=>{
    const c=object(item);
    if(Object.keys(c).some((key)=>!['address','instance','port','protocol','ttlMs','issue'].includes(key))||
      typeof c.address!=='string'||!isIPv4(c.address)||!plan.targets.includes(c.address)||
      typeof c.instance!=='string'||!c.instance.length||c.instance.length>253||/[\u0000-\u001f\u007f]/u.test(c.instance)||
      (c.port!==null&&(typeof c.port!=='number'||!Number.isInteger(c.port)||c.port<1||c.port>65535))||
      (typeof c.protocol!=='string'||!['rest','rpc','unknown'].includes(c.protocol))||
      typeof c.ttlMs!=='number'||!Number.isInteger(c.ttlMs)||c.ttlMs<0||c.ttlMs>10000||
      (c.issue!==null&&(typeof c.issue!=='string'||!candidateCodes.includes(c.issue))))throw new Error('Invalid resolution');
    if(c.issue===null&&(c.protocol!=='rest'||c.port===null||c.ttlMs===0))throw new Error('Invalid resolved endpoint');
    return c as unknown as GlancesCandidate;
  });
  if(new Set(candidates.map((c)=>c.address+'|'+c.instance)).size!==candidates.length)throw new Error('Duplicate endpoint');
  return {candidates,datagramsSent:row.datagramsSent as number,packetsReceived:row.packetsReceived as number,omitted:row.omitted as number,issues:row.issues as string[]};
}
export const createGlancesWorker=(data:unknown,options:WorkerOptions)=>new Worker(new URL('./glances-worker.mjs',import.meta.url),{...options,workerData:data});
export class GlancesEnricher{
  private disabled=false;
  constructor(private readonly store:Store,private readonly interfaces=localInterfaces,
    private readonly workerFactory=createGlancesWorker,private readonly read=glancesRequest){}
  get problem(){return this.disabled?'Automatic stats cleanup or storage failed. Restart Neo after resolving local storage before collecting again.':null;}
  private revalidate(plan:DiscoveryPlan,jobId:string){
    const current=parseDiscovery({requestId:jobId,interfaceId:plan.interface.id,cidr:plan.cidr,methods:plan.methods,ports:plan.ports,
      ...(plan.resolver?{resolver:plan.resolver}:{}),linkScopeConfirmed:plan.linkScopeConfirmed,glancesScheme:plan.glances?.scheme,tcpConcurrency:plan.tcpConcurrency,tcpAttemptLimit:plan.tcpAttemptLimit,maxDurationMs:plan.maxDurationMs,confirmScope:true},this.interfaces(),true).plan;
    if(JSON.stringify(current)!==JSON.stringify(plan))throw new Error('Interface changed');
  }
  private resolve(plan:DiscoveryPlan,signal:AbortSignal):Promise<GlancesResolution>{
    const attemptId=randomUUID(),worker=this.workerFactory({v:1,attemptId,plan},{execArgv:[],env:{},
      resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:4},stdout:true,stderr:true});
    worker.stdout.resume();worker.stderr.resume();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=async(error:Error|null,result?:GlancesResolution)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        let cleanup:ReturnType<typeof setTimeout>|undefined;
        try{
          const stopped=await Promise.race([worker.terminate().then(()=>true),new Promise<boolean>((done)=>{cleanup=setTimeout(()=>done(false),1000);})]);
          if(!stopped)throw new Error('cleanup');
        }catch{this.disabled=true;worker.unref();error=new Error('Resolver cleanup failed');}
        finally{clearTimeout(cleanup);}
        if(error)reject(error);else resolve(result!);
      };
      const abort=()=>void finish(new Error('Resolver cancelled'));
      const timer=setTimeout(()=>void finish(new Error('Resolver deadline')),8500);
      signal.addEventListener('abort',abort,{once:true});
      worker.on('message',(raw:unknown)=>{
        if(settled)return;
        try{
          if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)throw new Error('message');
          const message=object(JSON.parse(raw));
          if(Object.keys(message).some((key)=>!['v','attemptId','result'].includes(key))||message.v!==1||message.attemptId!==attemptId)throw new Error('message');
          void finish(null,validateResolution(message.result,plan));
        }catch{void finish(new Error('Invalid resolver result'));}
      });
      worker.once('error',()=>void finish(new Error('Resolver failed')));
      worker.once('exit',()=>{if(!settled)void finish(new Error('Resolver exited'));});
      if(signal.aborted)abort();
    });
  }
  async run(job:Job,signal:AbortSignal,publish:(state:GlancesEnrichment)=>void):Promise<boolean>{
    const plan=job.spec.discovery;
    if(!plan?.glances)return false;
    if(this.disabled)throw new Error('Enrichment unavailable');
    const state:GlancesEnrichment={phase:'resolving',datagramsSent:0,packetsReceived:0,omitted:0,issues:[],endpoints:[]};
    const update=()=>publish(structuredClone(state));
    update();
    try{
      signal.throwIfAborted();this.revalidate(plan,job.id);
      const started=Date.now(),result=await this.resolve(plan,signal);
      signal.throwIfAborted();
      Object.assign(state,{datagramsSent:result.datagramsSent,packetsReceived:result.packetsReceived,omitted:result.omitted,issues:result.issues,
        endpoints:result.candidates.map((c)=>({...c,status:'pending' as const}))});
      state.phase='reading';update();
      // Two endpoint tasks maximum. Paths remain sequential within each direct one-socket transport.
      const selected=new Set<string>();
      await Promise.all(state.endpoints.map(async(endpoint)=>{
        if(signal.aborted)return;
        if(endpoint.issue||started+endpoint.ttlMs<=Date.now()||result.issues.some((code)=>['socket_error','response_cap','record_cap','cancelled'].includes(code))){
          endpoint.status='skipped';endpoint.reason=endpoint.issue??(started+endpoint.ttlMs<=Date.now()?'expired':'resolution_incomplete');update();return;
        }
        const key=endpoint.address+':'+endpoint.port;
        if(selected.has(key)){endpoint.status='skipped';endpoint.reason='duplicate_endpoint';update();return;}selected.add(key);
        try{
          this.revalidate(plan,job.id);
          const asset=this.store.assets().find((asset)=>asset.latest?.subjectKey===job.id+'/'+endpoint.address);
          if(!asset){endpoint.status='skipped';endpoint.reason='no_current_observation';update();return;}
          endpoint.status='reading';update();
          const controller=new AbortController(),abort=()=>controller.abort();
          signal.addEventListener('abort',abort,{once:true});
          const deadline=setTimeout(()=>controller.abort(),12000);
          try{
            const snapshot=await readGlances({assetId:asset.id,address:endpoint.address,sourceAddress:plan.interface.address,
              scheme:plan.glances!.scheme,port:endpoint.port!,requestId:randomUUID()},controller.signal,this.read);
            if(snapshot.issues.some((issue)=>issue.code==='cleanup_failed'))this.disabled=true;
            // A cancellation may retain the completed sections, but never changes a terminal job afterward.
            try{this.store.saveStats(snapshot);}catch{this.disabled=true;throw new Error('storage');}
            endpoint.snapshotId=snapshot.id;endpoint.status=snapshot.status;
            endpoint.reason=snapshot.issues[0]?.code;update();
          }finally{clearTimeout(deadline);signal.removeEventListener('abort',abort);}
        }catch{endpoint.status='failed';endpoint.reason=signal.aborted?'cancelled':'interface_or_storage_unavailable';update();}
      }));
      signal.throwIfAborted();state.phase='completed';update();
      return state.issues.some((code)=>code!=='no_advertisements')||state.endpoints.some((endpoint)=>endpoint.status!=='complete');
    }catch{
      if(signal.aborted){state.phase='cancelled';for(const endpoint of state.endpoints)if(['pending','reading'].includes(endpoint.status)){endpoint.status='skipped';endpoint.reason='cancelled';}update();throw new Error('Enrichment cancelled');}
      state.issues.push(this.disabled?'cleanup_failed':'resolution_failed');state.phase='completed';update();return true;
    }
  }
}
