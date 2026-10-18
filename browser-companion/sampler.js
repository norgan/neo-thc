// Serialized by chrome.scripting into the isolated world. Do not add external dependencies.
export async function samplePlayback({durationSeconds=20}={}) {
  if(!Number.isInteger(durationSeconds)||durationSeconds<10||durationSeconds>60)throw new Error('Choose 10–60 seconds.');
  const provider=['www.youtube.com','youtube.com','m.youtube.com'].includes(location.hostname)?'youtube':['www.netflix.com','netflix.com'].includes(location.hostname)?'netflix':null;
  if(!provider)throw new Error('Open a playing YouTube or Netflix tab.');
  if(globalThis.__neoPlaybackCapture)throw new Error('A NEO capture is already active in this tab.');
  const videos=[...document.querySelectorAll('video')].slice(0,32).filter(v=>{const r=v.getBoundingClientRect();return r.width>0&&r.height>0&&!v.ended;}).sort((a,b)=>Number(a.paused)-Number(b.paused)||b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight);
  const video=videos[0];if(!video)throw new Error('No visible player found. Start a video, then capture again.');
  const state={stop:false};globalThis.__neoPlaybackCapture=state;
  const started=performance.now(),capturedAt=Date.now(),samples=[];
  let startedPlayback=!video.paused&&!video.seeking&&video.readyState>=3,waitingSince=null,waitingEvents=0,stalledEvents=0,rebufferMs=0,longTaskMs=null,stopReason='finished';
  const closeWait=()=>{if(waitingSince!==null){rebufferMs+=performance.now()-waitingSince;waitingSince=null;}};
  const waiting=()=>{if(startedPlayback&&!video.paused&&!video.seeking&&waitingSince===null){waitingEvents++;waitingSince=performance.now();}};
  const playing=()=>{startedPlayback=true;closeWait();};
  const stalled=()=>{stalledEvents++;};
  const handlers={waiting,playing,stalled,pause:closeWait,seeking:closeWait,ended:closeWait};
  const hidden=()=>{if(document.visibilityState!=='visible'){state.stop=true;stopReason='tab_hidden';}};
  document.addEventListener('visibilitychange',hidden);
  for(const [event,fn] of Object.entries(handlers))video.addEventListener(event,fn);
  let observer;
  try{if(PerformanceObserver.supportedEntryTypes.includes('longtask')){longTaskMs=0;observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTaskMs+=entry.duration;});observer.observe({type:'longtask',buffered:false});}}catch{}
  function sample(){
    let bufferSeconds=null;try{bufferSeconds=0;for(let i=0;i<video.buffered.length;i++){if(video.buffered.start(i)<=video.currentTime&&video.buffered.end(i)>=video.currentTime){bufferSeconds=Math.min(86400,video.buffered.end(i)-video.currentTime);break;}}}catch{}
    let totalFrames=null,droppedFrames=null;try{const q=video.getVideoPlaybackQuality?.();if(q&&Number.isFinite(q.totalVideoFrames)&&Number.isFinite(q.droppedVideoFrames)){totalFrames=q.totalVideoFrames;droppedFrames=q.droppedVideoFrames;}}catch{}
    samples.push({atMs:Math.min(65000,Math.round(performance.now()-started)),mediaTime:Number.isFinite(video.currentTime)?Math.max(0,video.currentTime):0,width:video.videoWidth,height:video.videoHeight,bufferSeconds,totalFrames,droppedFrames,paused:video.paused,seeking:video.seeking,readyState:video.readyState,visibility:document.visibilityState==='visible'?'visible':'hidden'});
  }
  try{
    sample();
    while(performance.now()-started<durationSeconds*1000){
      await new Promise(resolve=>setTimeout(resolve,500));
      if(state.stop){if(stopReason==='finished')stopReason='stopped';sample();break;}
      if(!video.isConnected){stopReason='player_changed';break;}
      sample();if(video.ended){stopReason='ended';break;}
    }
  } finally {closeWait();observer?.disconnect();document.removeEventListener('visibilitychange',hidden);for(const [event,fn] of Object.entries(handlers))video.removeEventListener(event,fn);delete globalThis.__neoPlaybackCapture;}
  const durationMs=Math.min(65000,Math.round(performance.now()-started));
  const n=navigator.connection;
  return {schema:1,provider,capturedAt,durationMs,stopReason,browser:/Firefox\//.test(navigator.userAgent)?'Firefox':/Chrome\//.test(navigator.userAgent)?'Chromium':'Other',waitingEvents,stalledEvents,rebufferMs:Math.min(durationMs,Math.round(rebufferMs)),longTaskMs:longTaskMs===null?null:Math.min(durationMs,Math.round(longTaskMs)),connection:{effectiveType:['slow-2g','2g','3g','4g'].includes(n?.effectiveType)?n.effectiveType:null,downlinkMbps:Number.isFinite(n?.downlink)?n.downlink:null,rttMs:Number.isFinite(n?.rtt)?n.rtt:null,saveData:typeof n?.saveData==='boolean'?n.saveData:null},samples:samples.slice(0,131)};
}
