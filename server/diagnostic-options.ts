import {getServers} from 'node:dns';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {internetSettings,windowsDnsConfiguration} from './internet-network.mjs';

export function parseDiagnosticDns(raw:string):{interface:string;address:string;family:number;supported:boolean}[]{
  if(Buffer.byteLength(raw)>65536)throw new Error('config');
  const data:unknown=JSON.parse(raw.replace(/^\uFEFF/,'')),rows=Array.isArray(data)?data:[data];
  if(rows.length>128)throw new Error('config');
  return rows.flatMap((row)=>{
    if(!row||typeof row!=='object'||typeof row.InterfaceAlias!=='string'||row.InterfaceAlias.length>256||!Array.isArray(row.ServerAddresses)||row.ServerAddresses.length>16)return [];
    return row.ServerAddresses.filter((address:unknown):address is string=>typeof address==='string'&&address.length<=128&&!!isIP(address)).map((address:string)=>({
      interface:row.InterfaceAlias,address,family:isIP(address),supported:!address.includes('%')&&!/^fe[89ab]/i.test(address),
    }));
  }).slice(0,128);
}
export async function diagnosticOptions(signal=new AbortController().signal){
  signal.throwIfAborted();
  let configured:ReturnType<typeof parseDiagnosticDns>=[],source='System-wide DNS configuration';
  if(process.platform==='win32'){
    try{
      const raw=await windowsDnsConfiguration(signal);if(!raw)throw new Error('config');
      configured=parseDiagnosticDns(raw);source='Windows IPv4 and IPv6 interface DNS configuration';
    }catch{source='System-wide DNS configuration (interface read unavailable)';}
  }
  signal.throwIfAborted();
  const system=getServers().slice(0,8).map((address)=>({interface:'System resolver list',address,family:isIP(address),supported:!!isIP(address)&&!address.includes('%')&&!/^fe[89ab]/i.test(address)}));
  const interfaces=Object.entries(networkInterfaces()).flatMap(([name,rows])=>(rows??[]).filter((row)=>!row.internal).map((row)=>({name,address:row.address,family:row.family,cidr:row.cidr}))).slice(0,64);
  // Prefer the OS resolver list over dormant/virtual adapters; retain other interface entries as evidence.
  const known=new Set(system.map((row)=>row.address));
  const resolvers=[...system.map((row)=>({...row,interface:configured.find((entry)=>entry.address===row.address)?.interface??row.interface})),
    ...configured.filter((row)=>!known.has(row.address))];
  let gateway:string|null=null;
  try{const settings=await internetSettings(AbortSignal.any([signal,AbortSignal.timeout(4200)]));if(settings.gateway&&isIP(settings.gateway)===4)gateway=settings.gateway;}catch{}
  signal.throwIfAborted();
  return {source,resolvers,interfaces,gateway};
}
