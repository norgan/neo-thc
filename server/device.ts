import {cpus,freemem,totalmem,platform} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {command} from './internet-network.mjs';
import type {DeviceEvidence} from '../shared/playback.js';
export function parseWindowsWifi(raw:string|null):DeviceEvidence['wifi'] {
  const wifi:DeviceEvidence['wifi']={status:'unavailable',signalPercent:null,receiveMbps:null,transmitMbps:null,radio:null,channel:null};
  if(!raw||raw.length>32768||(raw.match(/^\s*State\s*:\s*connected\s*$/gim)??[]).length!==1)return wifi;
  // Do not retain SSID, BSSID, MAC, interface IDs or raw command output.
  const fields=new Map<string,string>();for(const line of raw.split(/\r?\n/)){const match=line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);if(match)fields.set(match[1].toLowerCase(),match[2]);}
  if(fields.get('state')!=='connected')return wifi;
  const read=(key:string,max:number)=>{const n=Number(fields.get(key)?.replace('%',''));return fields.has(key)&&Number.isFinite(n)&&n>=0&&n<=max?n:null;};
  wifi.signalPercent=read('signal',100);wifi.receiveMbps=read('receive rate (mbps)',100000);wifi.transmitMbps=read('transmit rate (mbps)',100000);wifi.channel=read('channel',4096);
  const radio=fields.get('radio type');wifi.radio=radio&&/^802\.11[a-z0-9/ .-]{1,24}$/i.test(radio)?radio:null;
  if(wifi.signalPercent!==null||wifi.receiveMbps!==null)wifi.status='read';return wifi;
}
export async function deviceEvidence(signal:AbortSignal,vantage:DeviceEvidence['vantage']='collector'):Promise<DeviceEvidence>{
  const before=cpus();
  const wifiRead=platform()==='win32'?command(join(process.env.SystemRoot??'C:\\Windows','System32','netsh.exe'),['wlan','show','interfaces'],signal,4000):Promise.resolve(null);
  const [,raw]=await Promise.all([delay(350,undefined,{signal}),wifiRead]);const after=cpus();
  let idle=0,total=0;for(let i=0;i<Math.min(before.length,after.length);i++){idle+=after[i].times.idle-before[i].times.idle;total+=Object.values(after[i].times).reduce((a,b)=>a+b,0)-Object.values(before[i].times).reduce((a,b)=>a+b,0);}
  signal.throwIfAborted();
  return {observedAt:Date.now(),vantage,platform:platform(),logicalCpus:after.length,cpuBusyPercent:total>0?Math.max(0,Math.min(100,100*(1-idle/total))):null,memoryUsedPercent:100*(1-freemem()/totalmem()),wifi:platform()==='win32'?parseWindowsWifi(raw):{status:'unsupported',signalPercent:null,receiveMbps:null,transmitMbps:null,radio:null,channel:null}};
}
