import {isIP} from 'node:net';
import type {Job,DiagnosticReport,InternetCheck} from '../shared/types.js';
import {MEDIA_HOSTS,INTERNET_TARGET,DOWNLOAD_BYTES,INTERNET_DURATION_MS,internetFindings,type InternetPlan} from '../shared/internet.js';
import {dnsCheck} from './diagnostic-network.mjs';
import {internetSettings,latencyCheck,mtuCheck,transferCheck,InternetCleanupError} from './internet-network.mjs';

export type InternetProbes={settings:typeof internetSettings;dns:typeof dnsCheck;latency:typeof latencyCheck;mtu:typeof mtuCheck;transfer:typeof transferCheck};
const probes:InternetProbes={settings:internetSettings,dns:dnsCheck,latency:latencyCheck,mtu:mtuCheck,transfer:transferCheck};
function object(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('result');return value as Record<string,unknown>;}
function keys(row:Record<string,unknown>,allowed:string[]){if(Object.keys(row).some((key)=>!allowed.includes(key)))throw new Error('fields');}
function number(value:unknown,min:number,max:number){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;}
export function validateInternetCheck(value:unknown,kind:InternetCheck['kind'],target?:string):InternetCheck {
  const row=object(value);if(row.kind!==kind)throw new Error('kind');
  if(kind==='settings'){
    keys(row,['kind','status','gateway','interfaces']);
    if(!['read','unavailable'].includes(String(row.status))||(row.gateway!==null&&(typeof row.gateway!=='string'||isIP(row.gateway)!==4))||!Array.isArray(row.interfaces)||row.interfaces.length>64)throw new Error('settings');
    for(const value of row.interfaces){const item=object(value);keys(item,['name','family','mtu','defaultRoute','dhcp']);
      if(typeof item.name!=='string'||!item.name.length||item.name.length>256||item.family!==4&&item.family!==6||!number(item.mtu,68,65535)||!Number.isInteger(item.mtu)||typeof item.defaultRoute!=='boolean'||item.dhcp!==null&&typeof item.dhcp!=='boolean')throw new Error('interface');}
    if(row.status==='unavailable'&&(row.interfaces.length||row.gateway!==null))throw new Error('unavailable');
  }else{
    if(!number(row.durationMs,0,15000))throw new Error('duration');
    if(kind==='latency'){
      keys(row,['kind','target','samples','durationMs']);if(row.target!==target||!Array.isArray(row.samples)||row.samples.length!==3)throw new Error('latency');
      for(const value of row.samples){const sample=object(value);keys(sample,['status','rttMs']);if(!['reply','timeout','too_big','unreachable','unavailable'].includes(String(sample.status))||
        (sample.status==='reply'?!number(sample.rttMs,0,10000):sample.rttMs!==null))throw new Error('sample');}
    }else if(kind==='mtu'){
      keys(row,['kind','target','status','mtu','probes','durationMs']);if(row.target!==target||!['at_least_1500','reduced','inconclusive'].includes(String(row.status))||!Array.isArray(row.probes)||!row.probes.length||row.probes.length>11)throw new Error('mtu');
      for(const value of row.probes){const probe=object(value);keys(probe,['payload','status']);if(!number(probe.payload,1200,1472)||!Number.isInteger(probe.payload)||!['reply','timeout','too_big','unreachable','unavailable'].includes(String(probe.status)))throw new Error('probe');}
      const entries=row.probes as {payload:number;status:string}[];
      if(row.status==='inconclusive'?row.mtu!==null:row.status==='at_least_1500'?row.mtu!==1500||!entries.some((probe)=>probe.payload===1472&&probe.status==='reply'):
        !number(row.mtu,1228,1499)||entries.some((probe)=>!['reply','too_big'].includes(probe.status))||
        !entries.some((probe)=>probe.status==='reply'&&probe.payload+28===row.mtu)||!entries.some((probe)=>probe.status==='too_big'&&probe.payload+27===row.mtu))throw new Error('mtu_evidence');
    }else{
      keys(row,['kind','status','bytes','durationMs','mbps']);if(!['complete','deadline','http_error','tls_error','unavailable','byte_cap'].includes(String(row.status))||!number(row.bytes,0,DOWNLOAD_BYTES)||!Number.isInteger(row.bytes))throw new Error('transfer');
      if(row.mbps!==null&&(!number(row.mbps,0,100000)||!['complete','deadline','byte_cap'].includes(String(row.status))||Number(row.bytes)<262144||Number(row.durationMs)<100||
        Math.abs(Number(row.mbps)-Number(row.bytes)*8/(Number(row.durationMs)*1000))>0.000001))throw new Error('rate');
    }
  }
  return structuredClone(row) as unknown as InternetCheck;
}
export class InternetRunner {
  private disabled=false;
  constructor(private readonly transport:InternetProbes=probes){}
  get problem(){return this.disabled?'Internet probe cleanup was not confirmed. Restart Neo before collecting again.':null;}
  async run(job:Job,signal:AbortSignal,publish:(value:DiagnosticReport)=>void,validateDns:(value:unknown,plan:InternetPlan,index:number)=>unknown):Promise<boolean>{
    const plan=job.spec.diagnostic;if(plan?.kind!=='internet'||this.disabled)throw new Error('Internet diagnosis unavailable');
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();const deadline=setTimeout(abort,INTERNET_DURATION_MS-1000),active=controller.signal;
    const report:DiagnosticReport={kind:'internet',hostname:plan.hostname,complete:false,vantage:'This Neo collector; selected DNS, gateway and fixed public test targets',startedAt:Date.now(),updatedAt:Date.now(),dns:[],connections:[],internet:[],findings:[]};
    const update=()=>{active.throwIfAborted();report.updatedAt=Date.now();report.findings=internetFindings(report);publish(structuredClone(report));};
    const add=(value:unknown,kind:InternetCheck['kind'],target?:string)=>{report.internet!.push(validateInternetCheck(value,kind,target));update();};
    try{
      update();add(await this.transport.settings(active),'settings');let index=0;
      for(const hostname of MEDIA_HOSTS)for(const source of plan.resolvers)for(const type of ['A','AAAA'] as const){
        active.throwIfAborted();const result={...await this.transport.dns(hostname,source,type,plan.port,undefined,active),hostname};
        validateDns(result,plan,index++);report.dns.push(result);update();
      }
      if(plan.gateway)add(await this.transport.latency(plan.gateway,active),'latency',plan.gateway);
      add(await this.transport.latency(INTERNET_TARGET,active),'latency',INTERNET_TARGET);
      add(await this.transport.mtu(INTERNET_TARGET,active),'mtu',INTERNET_TARGET);
      if(plan.download)add(await this.transport.transfer(active),'transfer');
      active.throwIfAborted();report.complete=true;update();
      return report.dns.some((row)=>!['answer','no_data'].includes(row.status))||report.internet!.some((check)=>check.kind==='settings'?check.status==='unavailable':check.kind==='latency'?check.samples.some((sample)=>sample.status!=='reply'):check.kind==='mtu'?check.status==='inconclusive':!['complete','byte_cap'].includes(check.status));
    }catch(error){if(error instanceof InternetCleanupError)this.disabled=true;throw error;}
    finally{clearTimeout(deadline);signal.removeEventListener('abort',abort);controller.abort();}
  }
}
