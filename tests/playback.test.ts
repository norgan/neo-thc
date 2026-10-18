import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {parsePlayback,playbackSummary,type PlaybackCapture} from '../shared/playback.js';
import {parseWindowsWifi} from '../server/device.js';
import {Store} from '../server/store.js';
import {createApp} from '../server/app.js';
export const capture=():PlaybackCapture=>({schema:1,provider:'netflix',capturedAt:1792300240077,durationMs:20000,stopReason:'finished',browser:'Chromium',waitingEvents:1,stalledEvents:1,rebufferMs:1500,longTaskMs:null,connection:{effectiveType:null,downlinkMbps:null,rttMs:null,saveData:null},samples:[{atMs:0,mediaTime:10,width:1920,height:1080,bufferSeconds:15,totalFrames:100,droppedFrames:0,paused:false,seeking:false,readyState:4,visibility:'visible'},{atMs:20000,mediaTime:28.5,width:1280,height:720,bufferSeconds:0,totalFrames:700,droppedFrames:12,paused:false,seeking:false,readyState:2,visibility:'visible'}]});
test('playback report validates bounded measurements and rejects URL, title, account data, NaN and invalid counters',()=>{
  const c=capture();assert.deepEqual(parsePlayback(c),c);
  for(const invalid of [{...c,url:'https://example.test/private'},{...c,title:'private'},{...c,durationMs:66000},{...c,rebufferMs:21000},{...c,connection:{...c.connection,ssid:'private'}},{...c,samples:Array(132).fill(c.samples[0])},{...c,samples:[{...c.samples[0],width:NaN}]},{...c,samples:[{...c.samples[0],droppedFrames:101}]}])assert.throws(()=>parsePlayback(invalid));
});
test('playback diagnosis uses counter deltas, changing resolution and observed rebuffering without asserting a root cause',()=>{
  const summary=playbackSummary(capture());assert.equal(summary.droppedFrames,12);assert.equal(summary.totalFrames,600);assert.equal(summary.droppedPercent,2);assert.deepEqual(summary.resolutions,['1920 × 1080','1280 × 720']);assert.equal(summary.minBufferSeconds,0);assert.ok(summary.findings.some(s=>s.includes('does not identify the cause')));
});
test('unknown counters, resets, hidden and paused samples remain explicit',()=>{
  const c=capture();c.samples[1].totalFrames=10;c.samples[1].droppedFrames=0;c.samples[1].visibility='hidden';c.samples[0].paused=true;
  const s=playbackSummary(c);assert.equal(s.droppedPercent,null);assert.equal(s.totalFrames,null);assert.ok(s.findings.some(x=>x.includes('reset')));assert.ok(s.findings.some(x=>x.includes('hidden')));assert.ok(s.findings.some(x=>x.includes('No visible')));
});
test('native Wi-Fi normalization retains only signal/link fields and never network identity',()=>{
  const wifi=parseWindowsWifi('State : connected\nSSID : private-name\nBSSID : 00:11:22:33:44:55\nSignal : 48%\nReceive rate (Mbps) : 866.7\nTransmit rate (Mbps) : 400\nRadio type : 802.11ax\nChannel : 36');
  assert.equal(wifi.signalPercent,48);assert.equal(wifi.receiveMbps,866.7);assert.equal(wifi.radio,'802.11ax');assert.ok(!JSON.stringify(wifi).includes('private-name'));assert.ok(!JSON.stringify(wifi).includes('00:11'));assert.equal(parseWindowsWifi('Location permission denied').status,'unavailable');assert.equal(parseWindowsWifi('State : connected\nSignal : 999%').signalPercent,null);
});
test('schema v2 upgrades preserve jobs and retain playback across reopen; newer schemas fail closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'neo-playback-'));const path=join(dir,'neo.sqlite');
  try{const old=new Store(path);old.close();const legacy=new DatabaseSync(path);legacy.exec('DROP TABLE playback_reports; PRAGMA user_version=2');legacy.close();
    const store=new Store(path);const saved=store.savePlayback(capture());store.close();const reopened=new Store(path);assert.deepEqual(reopened.playback(),[saved]);reopened.close();
    const future=new DatabaseSync(path);future.exec('PRAGMA user_version=4');future.close();assert.throws(()=>new Store(path),/newer/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('playback import API preserves validated evidence and enforces host, origin, header and size policy',async()=>{
  const {app}=createApp();try{
    const ok=await app.inject({method:'POST',url:'/api/v1/playback',headers:{host:'127.0.0.1:4318','x-neo-client':'local-ui'},payload:capture()});assert.equal(ok.statusCode,201);
    const list=await app.inject({url:'/api/v1/playback',headers:{host:'127.0.0.1:4318'}});assert.equal(list.json().reports.length,1);
    for(const headers of [{host:'evil.example','x-neo-client':'local-ui'},{host:'127.0.0.1:4318',origin:'https://evil.example','x-neo-client':'local-ui'},{host:'127.0.0.1:4318'}])assert.equal((await app.inject({method:'POST',url:'/api/v1/playback',headers,payload:capture()})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/playback',headers:{host:'127.0.0.1:4318','x-neo-client':'local-ui'},payload:{...capture(),title:'private'}})).statusCode,400);
  }finally{await app.close();}
});
test('actual serialized browser sampler measures waiting, resolution and frames, excludes seeks and removes listeners',async()=>{
  const source=(await readFile(new URL('../browser-companion/sampler.js',import.meta.url),'utf8')).replace('export async function','async function');
  let clock=0;const handlers=new Map<string,()=>void>();
  const video={ended:false,paused:false,seeking:false,readyState:4,isConnected:true,currentTime:10,videoWidth:1920,videoHeight:1080,clientWidth:100,clientHeight:100,buffered:{length:1,start:()=>0,end:()=>30},getBoundingClientRect:()=>({width:100,height:100}),getVideoPlaybackQuality:()=>({totalVideoFrames:100+clock/20,droppedVideoFrames:clock>=5000?5:0}),addEventListener:(e:string,f:()=>void)=>handlers.set(e,f),removeEventListener:(e:string)=>handlers.delete(e)};
  const context={location:{hostname:'www.netflix.com'},document:{querySelectorAll:()=>[video],visibilityState:'visible',addEventListener:()=>{},removeEventListener:()=>{}},navigator:{userAgent:'Chrome/150'},performance:{now:()=>clock},Date,PerformanceObserver:class{static supportedEntryTypes:string[]=[];},setTimeout:(fn:()=>void,ms:number)=>{clock+=ms;if(clock===1000)handlers.get('waiting')?.();if(clock===2500)handlers.get('playing')?.();if(clock===4000){video.seeking=true;handlers.get('seeking')?.();handlers.get('waiting')?.();}if(clock===4500)video.seeking=false;video.currentTime+=.5;queueMicrotask(fn);}};
  const fn=vm.runInNewContext(source+';samplePlayback',context) as (x:{durationSeconds:number})=>Promise<unknown>;
  const report=parsePlayback(await fn({durationSeconds:10}));assert.equal(report.waitingEvents,1);assert.equal(report.rebufferMs,1500);assert.equal(report.samples.length,21);assert.equal(playbackSummary(report).droppedFrames,5);assert.equal(handlers.size,0);assert.ok(!JSON.stringify(report).includes('netflix.com'));
});
