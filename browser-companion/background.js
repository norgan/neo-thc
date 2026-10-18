import {samplePlayback} from './sampler.js';
const safeError=error=>['Open a playing YouTube or Netflix tab.','No visible player found. Start a video, then capture again.','A NEO capture is already active in this tab.','A capture is already running.','Select the playback tab.'].includes(error?.message)?error.message:'Playback capture unavailable. Keep the video tab open and try again.';
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message?.action==='start'){
    void (async()=>{
      const prior=await chrome.storage.session.get('status');if(prior.status?.running&&Date.now()-prior.status.started<75000)throw new Error('A capture is already running.');
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab?.id)throw new Error('Select the playback tab.');
      await chrome.storage.session.set({status:{running:true,tabId:tab.id,started:Date.now()},report:null,error:null});
      reply({ok:true});
      try{const results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:samplePlayback,args:[{durationSeconds:20}]});
        if(!results[0]?.result)throw new Error('Capture ended without a report. Keep the video tab open.');
        await chrome.storage.session.set({report:results[0].result,status:{running:false},error:null});
      }catch(error){await chrome.storage.session.set({status:{running:false},error:safeError(error)});}
    })().catch(error=>reply({error:safeError(error)}));return true;
  }
  if(message?.action==='stop'){
    void (async()=>{const {status}=await chrome.storage.session.get('status');if(status?.running)await chrome.scripting.executeScript({target:{tabId:status.tabId},world:'ISOLATED',func:()=>{if(globalThis.__neoPlaybackCapture)globalThis.__neoPlaybackCapture.stop=true;}});reply({ok:true});})().catch(()=>reply({error:'The playback tab is no longer available.'}));return true;
  }
});
