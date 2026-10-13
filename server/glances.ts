import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { isIPv4, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { GlancesStats } from '../shared/types.js';
import { networkFacts } from '../shared/inventory.js';
import { localInterfaces, parseDiscovery } from './discovery-scope.js';
import { RequestError } from './jobs.js';
import { Store } from './store.js';

export const GLANCES_PATHS=['/api/4/version','/api/4/system','/api/4/cpu','/api/4/mem','/api/4/fs','/api/4/uptime'] as const;
export type GlancesPath=typeof GLANCES_PATHS[number];
export interface GlancesTarget {assetId:string;address:string;sourceAddress:string;scheme:'http'|'https';port:number;requestId:string}
export class GlancesError extends Error {constructor(readonly code:string){super(code);}}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new GlancesError('invalid_response');
  return value as Record<string,unknown>;
}
function text(value:unknown,max=256):string|null {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))throw new GlancesError('invalid_response');
  return value;
}
function number(value:unknown,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw new GlancesError('invalid_response');
  return value;
}
function bytes(value:unknown):number {const result=number(value);if(!Number.isSafeInteger(result))throw new GlancesError('invalid_response');return result;}
export function normalizeGlances(path:GlancesPath,value:unknown):unknown {
  if(path==='/api/4/version') {
    const version=text(value,64);
    if(!version||!/^4\.[0-9]+\.[0-9]+(?:[.a-zA-Z0-9-]*)$/.test(version))throw new GlancesError('unsupported_version');
    return version;
  }
  if(path==='/api/4/uptime')return text(value,64);
  if(path==='/api/4/fs') {
    if(!Array.isArray(value)||value.length>128)throw new GlancesError('invalid_response');
    return value.map((unknownRow)=>{
      const row=object(unknownRow),mount=text(row.mnt_point,512);
      if(!mount)throw new GlancesError('invalid_response');
      const sizeBytes=bytes(row.size),freeBytes=bytes(row.free),usedBytes=bytes(row.used);
      if(freeBytes>sizeBytes||usedBytes>sizeBytes)throw new GlancesError('invalid_response');
      return {mount,type:text(row.fs_type,64),sizeBytes,freeBytes,usedBytes,percent:number(row.percent,100)};
    });
  }
  const row=object(value);
  if(path==='/api/4/cpu')return number(row.total,100);
  if(path==='/api/4/mem') {
    const totalBytes=bytes(row.total),availableBytes=bytes(row.available);
    if(availableBytes>totalBytes)throw new GlancesError('invalid_response');
    return {percent:number(row.percent,100),totalBytes,availableBytes};
  }
  if(path==='/api/4/system')return {hostname:text(row.hostname),operatingSystem:[text(row.os_name),text(row.os_version)].filter(Boolean).join(' ')||null};
  throw new GlancesError('invalid_response');
}
export function resolveGlancesTarget(store:Store,assetId:string,body:unknown,confirm=false,interfaces=localInterfaces()):GlancesTarget {
  if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError(400,'Provide an explicit stats endpoint.');
  const input=body as Record<string,unknown>;
  if(Object.keys(input).some((key)=>!['requestId','scheme','port','confirmed'].includes(key))||
    typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||
    !['http','https'].includes(String(input.scheme))||typeof input.port!=='number'||!Number.isInteger(input.port)||input.port<1||input.port>65535)
    throw new RequestError(400,'Choose an explicit HTTP/HTTPS scheme and one valid port. No URL, credentials or custom path is accepted.');
  if(confirm&&input.confirmed!==true)throw new RequestError(400,'Review and confirm this exact stats endpoint first.');
  const asset=store.assets().find((row)=>row.id===assetId),observation=asset?.latest;
  const facts=observation?networkFacts(observation):null;
  if(!observation||!facts)throw new RequestError(404,'Network system not found');
  const jobId=observation.subjectKey.split('/')[0],job=store.job(jobId),previous=job?.spec.discovery;
  if(!previous||!previous.targets.includes(facts.address))throw new RequestError(400,'This system needs a current scoped discovery record before a stats connection.');
  const validated=parseDiscovery({requestId:input.requestId,interfaceId:previous.interface.id,cidr:facts.address+'/32',
    methods:['tcp'],ports:[input.port],confirmScope:true},interfaces,true).plan;
  if(!validated.targets.includes(facts.address))throw new RequestError(400,'Stats target is not on the approved current interface.');
  return {assetId,address:facts.address,sourceAddress:validated.interface.address,scheme:input.scheme as 'http'|'https',port:input.port,requestId:input.requestId};
}
function errorCode(error:unknown):string {
  if(error instanceof GlancesError)return error.code;
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return 'tls_validation_failed';
  return code==='ECONNREFUSED'?'connection_refused':code==='ABORT_ERR'?'cancelled':'network_error';
}
/** Literal-IP, direct, source-bound requests only. No credentials, redirects, retries or environment-proxy configuration. */
export function glancesRequest(target:GlancesTarget,path:GlancesPath,signal:AbortSignal):Promise<unknown> {
  if(!isIPv4(target.address)||!isIPv4(target.sourceAddress)||!GLANCES_PATHS.includes(path))return Promise.reject(new GlancesError('unsupported_path'));
  return new Promise((resolve,reject)=>{
    let settled=false,released=false,received=0,socket:Socket|undefined,socketClosed=false;
    let resultError:GlancesError|null=null,resultValue:unknown,cleanup:ReturnType<typeof setTimeout>|undefined;
    const chunks:Buffer[]=[];
    const agent=target.scheme==='https'?new HttpsAgent({keepAlive:false,maxSockets:1,maxTotalSockets:1,proxyEnv:{}}):new HttpAgent({keepAlive:false,maxSockets:1,maxTotalSockets:1,proxyEnv:{}});
    const request=(target.scheme==='https'?httpsRequest:httpRequest)({
      hostname:target.address,port:target.port,path,method:'GET',family:4,localAddress:target.sourceAddress,
      agent,rejectUnauthorized:true,maxHeaderSize:8192,
      headers:{Accept:'application/json','Accept-Encoding':'identity','User-Agent':'Neo-local-readonly/1'},
    });
    const release=()=>{
      if(released||!settled||(socket&&!socketClosed))return;released=true;clearTimeout(cleanup);
      if(resultError)reject(resultError);else resolve(resultValue);
    };
    request.once('socket',(value)=>{socket=value;value.once('close',()=>{socketClosed=true;release();});if(settled)value.destroy();});
    const finish=(error:GlancesError|null,value?:unknown)=>{
      if(settled)return;settled=true;resultError=error;resultValue=value;clearTimeout(timer);signal.removeEventListener('abort',abort);
      cleanup=setTimeout(()=>{if(released)return;released=true;request.destroy();agent.destroy();reject(new GlancesError('cleanup_failed'));},250);
      request.destroy();agent.destroy();release();
    };
    const abort=()=>finish(new GlancesError('cancelled'));
    const timer=setTimeout(()=>finish(new GlancesError('timeout')),2000);
    signal.addEventListener('abort',abort,{once:true});
    request.once('error',(error)=>finish(new GlancesError(errorCode(error))));
    request.once('response',(response)=>{
      const status=response.statusCode??0;
      if(status!==200) {
        response.destroy();
        finish(new GlancesError(status===401||status===403?'authentication_required':status===404?'not_found':
          status===429?'rate_limited':status>=300&&status<400?'redirect_blocked':'http_error'));return;
      }
      if(response.rawHeaders.length>64||(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')||
        !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type']??'')) {
        response.destroy();finish(new GlancesError('invalid_response'));return;
      }
      response.on('data',(chunk:Buffer)=>{received+=chunk.length;if(received>262144){response.destroy();finish(new GlancesError('response_too_large'));}else chunks.push(chunk);});
      response.once('error',()=>finish(new GlancesError('network_error')));
      response.once('aborted',()=>finish(new GlancesError('network_error')));
      response.once('end',()=>{try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish(new GlancesError('invalid_response'));}});
    });
    if(signal.aborted)abort();else request.end();
  });
}
export async function readGlances(target:GlancesTarget,signal:AbortSignal,read=glancesRequest):Promise<GlancesStats> {
  const result:GlancesStats={id:randomUUID(),requestId:target.requestId,assetId:target.assetId,source:'glances-api-v4',
    endpoint:target.scheme+'://'+target.address+':'+target.port,sourceAddress:target.sourceAddress,sampledAt:Date.now(),
    version:null,status:'failed',hostname:null,operatingSystem:null,cpuPercent:null,memory:null,filesystems:null,uptime:null,issues:[]};
  try {result.version=normalizeGlances('/api/4/version',await read(target,'/api/4/version',signal)) as string;}
  catch(error){result.issues.push({section:'version',code:errorCode(error)});return result;}
  for(const path of GLANCES_PATHS.slice(1)) {
    if(signal.aborted){result.issues.push({section:path.split('/').pop()!,code:'cancelled'});break;}
    try {
      const value=normalizeGlances(path,await read(target,path,signal));
      if(path==='/api/4/system')Object.assign(result,value);
      else if(path==='/api/4/cpu')result.cpuPercent=value as number;
      else if(path==='/api/4/mem')result.memory=value as GlancesStats['memory'];
      else if(path==='/api/4/fs')result.filesystems=value as GlancesStats['filesystems'];
      else result.uptime=value as string|null;
    } catch(error) {
      const code=errorCode(error);result.issues.push({section:path.split('/').pop()!,code});
      if(code==='authentication_required'||code==='cancelled'||code==='cleanup_failed')break;
    }
  }
  const hasMetrics=result.cpuPercent!==null||result.memory!==null||result.filesystems!==null;
  result.status=hasMetrics?(result.issues.length?'partial':'complete'):'failed';
  return result;
}
