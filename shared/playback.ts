export interface PlaybackSample {
  atMs:number; mediaTime:number; width:number; height:number; bufferSeconds:number|null;
  totalFrames:number|null; droppedFrames:number|null; paused:boolean; seeking:boolean;
  readyState:number; visibility:'visible'|'hidden';
}
export interface PlaybackCapture {
  schema:1; provider:'youtube'|'netflix'; capturedAt:number; durationMs:number;
  stopReason:'finished'|'stopped'|'ended'|'player_changed'|'tab_hidden'; browser:string;
  waitingEvents:number; stalledEvents:number; rebufferMs:number; longTaskMs:number|null;
  connection:{effectiveType:string|null; downlinkMbps:number|null; rttMs:number|null; saveData:boolean|null};
  samples:PlaybackSample[];
}
export interface DeviceEvidence {
  observedAt:number; vantage:'this-computer'|'collector'; platform:string;
  cpuBusyPercent:number|null; memoryUsedPercent:number; logicalCpus:number;
  wifi:{status:'read'|'unavailable'|'unsupported'; signalPercent:number|null; receiveMbps:number|null; transmitMbps:number|null; radio:string|null; channel:number|null};
}
export interface PlaybackRecord {id:string; importedAt:number; capture:PlaybackCapture; device?:DeviceEvidence}
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function keys(x:Record<string,unknown>,allowed:string[]){if(Object.keys(x).some(k=>!allowed.includes(k)))throw new Error('Unexpected report fields. Import a NEO playback report without page URLs, titles or account data.');}
function number(x:unknown,min:number,max:number):x is number{return typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;}
function nullable(x:unknown,min:number,max:number){return x===null||number(x,min,max);}
export function parsePlayback(value:unknown):PlaybackCapture {
  const bad=()=>{throw new Error('Invalid playback report. Use the NEO browser companion to capture up to 60 seconds.');};
  if(!object(value))return bad();
  keys(value,['schema','provider','capturedAt','durationMs','stopReason','browser','waitingEvents','stalledEvents','rebufferMs','longTaskMs','connection','samples']);
  if(value.schema!==1||!['youtube','netflix'].includes(String(value.provider))||!number(value.capturedAt,1,8.64e15)||!number(value.durationMs,0,65000)||!['finished','stopped','ended','player_changed','tab_hidden'].includes(String(value.stopReason))||!['Chromium','Firefox','Other'].includes(String(value.browser))||!number(value.waitingEvents,0,10000)||!number(value.stalledEvents,0,10000)||!number(value.rebufferMs,0,Number(value.durationMs))||!nullable(value.longTaskMs,0,Number(value.durationMs))||!Array.isArray(value.samples)||value.samples.length<1||value.samples.length>131||!object(value.connection))return bad();
  keys(value.connection,['effectiveType','downlinkMbps','rttMs','saveData']);
  const c=value.connection;
  if(!(c.effectiveType===null||['slow-2g','2g','3g','4g'].includes(String(c.effectiveType)))||!nullable(c.downlinkMbps,0,100000)||!nullable(c.rttMs,0,60000)||!(c.saveData===null||typeof c.saveData==='boolean'))return bad();
  let last=-1;
  for(const s of value.samples){
    if(!object(s))return bad();keys(s,['atMs','mediaTime','width','height','bufferSeconds','totalFrames','droppedFrames','paused','seeking','readyState','visibility']);
    if(!number(s.atMs,0,Number(value.durationMs)+5)||s.atMs<last||!number(s.mediaTime,0,1e9)||!number(s.width,0,16384)||!number(s.height,0,16384)||!Number.isInteger(s.width)||!Number.isInteger(s.height)||!nullable(s.bufferSeconds,0,86400)||!nullable(s.totalFrames,0,1e12)||!nullable(s.droppedFrames,0,1e12)||typeof s.paused!=='boolean'||typeof s.seeking!=='boolean'||!number(s.readyState,0,4)||!Number.isInteger(s.readyState)||!['visible','hidden'].includes(String(s.visibility)))return bad();
    if(s.totalFrames!==null&&s.droppedFrames!==null&&Number(s.droppedFrames)>Number(s.totalFrames))return bad();last=s.atMs;
  }
  return structuredClone(value) as unknown as PlaybackCapture;
}
export function playbackSummary(c:PlaybackCapture){
  const active=c.samples.filter(s=>!s.paused&&!s.seeking&&s.visibility==='visible');
  const resolutions=[...new Set(active.filter(s=>s.width&&s.height).map(s=>`${s.width} × ${s.height}`))];
  let total=0,dropped=0,known=0,resets=0;
  for(let i=1;i<c.samples.length;i++){
    const a=c.samples[i-1],b=c.samples[i];
    if(a.totalFrames===null||b.totalFrames===null||a.droppedFrames===null||b.droppedFrames===null)continue;
    if(b.totalFrames<a.totalFrames||b.droppedFrames<a.droppedFrames||b.droppedFrames-a.droppedFrames>b.totalFrames-a.totalFrames){resets++;continue;}
    total+=b.totalFrames-a.totalFrames;dropped+=b.droppedFrames-a.droppedFrames;known++;
  }
  const buffers=active.flatMap(s=>s.bufferSeconds===null?[]:[s.bufferSeconds]);
  const droppedPercent=known&&total>0?100*dropped/total:null;
  const findings:string[]=[];
  if(c.durationMs<10000)findings.push('This capture is shorter than 10 seconds; collect a longer sample during the problem.');
  if(c.samples.some(s=>s.visibility==='hidden'))findings.push('The playback tab was hidden for part of the sample. Browser throttling can affect playback and frame counters.');
  if(!active.length)findings.push('No visible, unpaused playback was sampled. Start the video and capture again.');
  if(c.rebufferMs>0)findings.push('Playback waited for data after playback started. Compare buffer health with device Wi-Fi and Internet evidence captured at the same time; this alone does not identify the cause.');
  if(droppedPercent!==null&&droppedPercent>=1)findings.push('Frames were dropped during the sample. If the buffer stayed healthy, investigate decoding, graphics drivers, power saving and device load before blaming bandwidth.');
  if(c.longTaskMs!==null&&c.longTaskMs>c.durationMs*.1)findings.push('The player page spent substantial time in long tasks. Page or device load may contribute; this is not whole-device CPU usage.');
  if(resolutions.length>1)findings.push('The decoded video dimensions changed. Adaptive quality, an advert or a player transition can explain this; the report does not identify content.');
  if(!findings.length)findings.push('No rebuffering was observed in this sample.'+(droppedPercent!==null?' The measured dropped-frame rate was below 1%.':'')+' An intermittent problem may still occur outside it.');
  if(!known||resets)findings.push(resets?'Frame counters reset; deltas are reported only within valid segments.':'This browser did not expose usable frame counters. Dropped frames are unknown.');
  return {resolutions,totalFrames:known?total:null,droppedFrames:known?dropped:null,droppedPercent,minBufferSeconds:buffers.length?Math.min(...buffers):null,findings};
}
