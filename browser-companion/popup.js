const start=document.querySelector('#start'),stop=document.querySelector('#stop'),status=document.querySelector('#status'),download=document.querySelector('#download');
let downloadUrl,reportTime;
start.addEventListener('click',async()=>{start.disabled=true;const result=await chrome.runtime.sendMessage({action:'start'});if(result?.error)status.textContent=result.error;await refresh();});
stop.addEventListener('click',async()=>{await chrome.runtime.sendMessage({action:'stop'});await refresh();});
async function refresh(){const state=await chrome.storage.session.get(['status','report','error']);const running=state.status?.running===true&&Date.now()-state.status.started<75000;
  start.disabled=running;stop.hidden=!running;download.hidden=!state.report;
  status.textContent=running?'Capturing… You can close this popup; keep the video playing.':state.error|| (state.report?'Capture complete. Download the report and import it into NEO.':'Ready.');
  if(state.report&&reportTime!==state.report.capturedAt){if(downloadUrl)URL.revokeObjectURL(downloadUrl);reportTime=state.report.capturedAt;downloadUrl=URL.createObjectURL(new Blob([JSON.stringify(state.report,null,2)],{type:'application/json'}));download.href=downloadUrl;download.download='neo-playback-'+state.report.provider+'.json';}}
await refresh();setInterval(refresh,1000);
