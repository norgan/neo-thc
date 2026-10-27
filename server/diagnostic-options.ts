import {getServers} from 'node:dns';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {internetSettings,windowsDnsConfiguration} from './internet-network.mjs';
import {canonicalAddress} from '../shared/diagnostics.js';

export interface DiagnosticDnsServer {interface:string;address:string;family:number;supported:boolean;reason?:string;}

/** Preserve the interface scope as evidence; do not turn a scoped resolver into an unscoped probe. */
export function canonicalDnsAddress(address:string):string {
  const separator=address.indexOf('%');
  if(separator<0)return canonicalAddress(address);
  const scope=address.slice(separator+1);
  return canonicalAddress(address.slice(0,separator))+'%'+(/^\d{1,10}$/.test(scope)?String(Number(scope)):scope);
}

/** Support for the existing direct-DNS workbench. Benchmark-specific scope support is separate. */
export function dnsResolverProblem(address:string):string|null {
  if(!isIP(address))return 'This DNS endpoint is not a plain IP address. Enter its address and DNS port separately.';
  const value=canonicalDnsAddress(address).toLowerCase();
  if(value.includes('%'))return 'Interface-scoped IPv6 DNS requires an interface-aware probe; the configured address is retained.';
  if(/^fe[89ab]/.test(value))return 'Link-local IPv6 DNS needs an interface scope; the configured address is retained.';
  if(value==='::'||value==='0.0.0.0'||value.startsWith('ff')&&isIP(value)===6||isIP(value)===4&&Number(value.split('.')[0])>=224)
    return 'Unspecified and multicast addresses cannot identify one DNS resolver.';
  return null;
}

/** dns-bench's SocketAddrV6 parser preserves a numeric link-local interface index. */
export function benchmarkResolverProblem(address:string):string|null {
  if(!isIP(address))return 'Enter one literal DNS server address; configure its port separately.';
  const [bare,scope]=canonicalDnsAddress(address).toLowerCase().split('%');
  if(isIP(bare)===6){
    if(bare==='::'||bare.startsWith('ff')||bare.startsWith('::ffff:'))
      return 'Unspecified, multicast and IPv4-mapped addresses are unavailable for this DNS benchmark.';
    const linkLocal=/^fe[89ab]/.test(bare);
    if(scope!==undefined){
      if(!linkLocal)return 'An interface scope is only supported for a link-local IPv6 resolver.';
      if(!/^\d{1,10}$/.test(scope)||Number(scope)<1||Number(scope)>4294967295)
        return 'Link-local IPv6 DNS needs a numeric interface scope from 1 to 4294967295; named scopes are unavailable.';
    }else if(linkLocal)return 'Link-local IPv6 DNS needs its numeric interface scope, such as %12; no interface is guessed.';
  }else {
    const [first,second]=bare.split('.').map(Number);
    if(first===0||first>=224||first===169&&second===254)
      return 'Unspecified, multicast and IPv4 link-local addresses are unavailable for this DNS benchmark.';
  }
  return null;
}

function resolver(interfaceName:string,address:string):DiagnosticDnsServer {
  const canonical=canonicalDnsAddress(address),reason=dnsResolverProblem(canonical);
  return {interface:interfaceName,address:canonical,family:isIP(canonical),supported:reason===null,...(reason?{reason}:{})};
}

export function parseDiagnosticDns(raw:string):DiagnosticDnsServer[]{
  if(Buffer.byteLength(raw)>65536)throw new Error('config');
  const data:unknown=JSON.parse(raw.replace(/^\uFEFF/,'')),rows=Array.isArray(data)?data:[data];
  if(rows.length>128)throw new Error('config');
  const seen=new Set<string>();
  return rows.flatMap((row)=>{
    if(!row||typeof row!=='object'||typeof row.InterfaceAlias!=='string'||row.InterfaceAlias.length>256||!Array.isArray(row.ServerAddresses)||row.ServerAddresses.length>16)return [];
    return row.ServerAddresses.filter((address:unknown):address is string=>typeof address==='string'&&address.length<=128&&!!isIP(address))
      .map((address:string)=>resolver(row.InterfaceAlias,address)).filter((entry:DiagnosticDnsServer)=>{
        const key=JSON.stringify([entry.interface,entry.address]);if(seen.has(key))return false;seen.add(key);return true;
      });
  }).slice(0,128);
}

/** Prefer OS resolver ordering, then retain remaining adapter DNS, including unsupported entries. */
export function mergeDiagnosticDns(system:string[],configured:DiagnosticDnsServer[]):DiagnosticDnsServer[]{
  const result=new Map<string,DiagnosticDnsServer>(),labels=new Map<string,Set<string>>();
  for(const entry of configured){
    const address=canonicalDnsAddress(entry.address);
    const names=labels.get(address)??new Set<string>();names.add(entry.interface);labels.set(address,names);
  }
  for(const address of system.filter((value)=>typeof value==='string'&&value.length<=128).slice(0,128)){
    const row=resolver('System resolver list',address);
    const names=labels.get(row.address);if(names?.size)row.interface=[...names].join(', ');
    if(!result.has(row.address))result.set(row.address,row);
  }
  for(const entry of configured){
    const address=canonicalDnsAddress(entry.address);
    if(!result.has(address))result.set(address,resolver([...(labels.get(address)??[entry.interface])].join(', '),address));
  }
  return [...result.values()].slice(0,128);
}

export interface DiagnosticOptionsSources {
  platform?:NodeJS.Platform;
  systemServers?:typeof getServers;
  interfaces?:typeof networkInterfaces;
  readWindowsDns?:typeof windowsDnsConfiguration;
  readSettings?:typeof internetSettings;
}

export async function diagnosticOptions(signal=new AbortController().signal,sources:DiagnosticOptionsSources={}){
  signal.throwIfAborted();
  const platform=sources.platform??process.platform;
  const [dnsRead,settingsRead]=await Promise.allSettled([
    platform==='win32'?(sources.readWindowsDns??windowsDnsConfiguration)(signal):Promise.resolve(null),
    (sources.readSettings??internetSettings)(AbortSignal.any([signal,AbortSignal.timeout(4200)])),
  ]);
  signal.throwIfAborted();
  let configured:ReturnType<typeof parseDiagnosticDns>=[],source='System-wide DNS configuration';
  if(platform==='win32'){
    try{
      const raw=dnsRead.status==='fulfilled'?dnsRead.value:null;if(!raw)throw new Error('config');
      configured=parseDiagnosticDns(raw);source='Windows IPv4 and IPv6 interface DNS configuration';
    }catch{source='System-wide DNS configuration (interface read unavailable)';}
  }
  signal.throwIfAborted();
  let system:string[]=[];
  try{system=(sources.systemServers??getServers)();}catch{source+=' (system-wide resolver read unavailable)';}
  const interfaces=Object.entries((sources.interfaces??networkInterfaces)()).flatMap(([name,rows])=>(rows??[]).filter((row)=>!row.internal).map((row)=>({name,address:row.address,family:row.family,cidr:row.cidr}))).slice(0,64);
  const resolvers=mergeDiagnosticDns(system,configured);
  if(!resolvers.length)source+=' (no resolver addresses detected; a known resolver can be entered manually)';
  let gateway:string|null=null;
  if(settingsRead.status==='fulfilled'&&settingsRead.value.gateway&&isIP(settingsRead.value.gateway)===4)gateway=settingsRead.value.gateway;
  signal.throwIfAborted();
  return {source,resolvers,interfaces,gateway};
}
