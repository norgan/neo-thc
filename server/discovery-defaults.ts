import { execFile } from 'node:child_process';
import { getServers } from 'node:dns';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import type { DiscoveryDefaults, DiscoveryInterface } from '../shared/types.js';
import { cidrRange, ipv4Number } from './discovery-scope.js';

const command = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,ServerAddresses) | ConvertTo-Json -Compress -Depth 3';
function readWindows(): Promise<string> {
  return new Promise((resolve, reject) => execFile(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { shell:false, windowsHide:true, timeout:2000, maxBuffer:65536, encoding:'utf8' },
    (error, stdout) => error ? reject(new Error('DNS configuration unavailable')) : resolve(stdout),
  ));
}
export function parseWindowsDns(raw: string): Map<string, string[]> {
  if (Buffer.byteLength(raw) > 65536) throw new Error('DNS configuration too large');
  const value: unknown=JSON.parse(raw);
  const rows=Array.isArray(value)?value:[value];
  if(rows.length>128)throw new Error('DNS interface limit');
  const result=new Map<string,string[]>();
  for(const row of rows) {
    if(!row || typeof row!=='object' || typeof row.InterfaceAlias!=='string' ||
      row.InterfaceAlias.length>256 || !Array.isArray(row.ServerAddresses) ||
      row.ServerAddresses.length>16 || row.ServerAddresses.some((address:unknown)=>typeof address!=='string'||!isIPv4(address))) continue;
    result.set(row.InterfaceAlias.toLowerCase(),[...new Set(row.ServerAddresses as string[])]);
  }
  return result;
}
/** Fixed local configuration reads only: no DNS request, remote command, shell interpolation or guessed gateway. */
export function createDnsDefaultsReader(deps: {
  platform?: string; readWindows?: ()=>Promise<string>; systemServers?: ()=>string[]; now?: ()=>number;
} = {}) {
  type Configuration={expires:number;windows:Map<string,string[]>|null;system:string[];failed:boolean};
  let cached:Configuration|null=null;
  let pending:Promise<Configuration>|null=null;
  const now=deps.now??Date.now;
  return async (interfaces: DiscoveryInterface[]): Promise<Record<string,DiscoveryDefaults>> => {
    if(!cached || cached.expires<=now()) {
      pending??=(async()=>{
        let windows:Map<string,string[]>|null=null,failed=false;
        if((deps.platform??process.platform)==='win32') {
          try {windows=parseWindowsDns(await (deps.readWindows??readWindows)());} catch {failed=true;}
        }
        let system:string[]=[];
        try {system=(deps.systemServers??getServers)().filter((value)=>typeof value==='string'&&value.length<=128).slice(0,8);} catch {}
        return {expires:now()+10000,windows,system,failed};
      })();
      try {cached=await pending;} finally {pending=null;}
    }
    const config=cached;
    if(!config)throw new Error('DNS configuration unavailable');
    const result:Record<string,DiscoveryDefaults>={};
    for(const iface of interfaces) {
      const specific=config.windows?.get(iface.name.toLowerCase());
      const addresses=specific??config.system;
      const source=specific?'Windows interface DNS configuration':config.failed
        ?'System-wide DNS configuration (interface read unavailable)':'System-wide DNS configuration';
      const link=cidrRange(iface.cidr);
      const servers=addresses.map((address)=>{
        const supported=isIPv4(address)&&ipv4Number(address)>link.first&&ipv4Number(address)<link.last;
        return {address,supported,reason:supported?'On the selected interface subnet':'Unsupported here: resolver must be a literal IPv4 address on this interface subnet'};
      });
      result[iface.id]={source,resolver:servers.find((server)=>server.supported)?.address??'',servers};
    }
    return result;
  };
}
export const readDnsDefaults=createDnsDefaultsReader();
