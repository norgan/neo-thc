const form=document.querySelector('#connection'),mode=document.querySelector('#mode'),remote=document.querySelector('#remote'),status=document.querySelector('#status'),submit=document.querySelector('#submit');
mode.addEventListener('change',()=>remote.hidden=mode.value!=='remote');
document.querySelector('#ca').addEventListener('click',async()=>{try{const selected=await window.neoConnection.chooseCa();document.querySelector('#ca-status').textContent=selected?'Private CA selected. Certificate names and validity will still be checked.':'No private CA selected.';}catch{status.textContent='Could not read that CA certificate.';}});
form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;status.textContent='Checking connection…';try{const result=await window.neoConnection.connect({mode:mode.value,origin:document.querySelector('#origin').value.trim(),token:document.querySelector('#token').value.trim(),remember:document.querySelector('#remember').checked});status.textContent=result.error||'Connected.';}catch{status.textContent='Connection could not be changed.';}finally{document.querySelector('#token').value='';submit.disabled=false;}});
void window.neoConnection.info().then(info=>{mode.value=info.mode;remote.hidden=info.mode!=='remote';document.querySelector('#origin').value=info.origin;document.querySelector('#remember').disabled=!info.canRemember;if(info.caSelected)document.querySelector('#ca-status').textContent='Previously selected private CA is active. Certificate names and validity will still be checked.';});
const assistantForm=document.querySelector('#assistant'),assistantFields=document.querySelector('#assistant-fields'),assistantKey=document.querySelector('#assistant-key'),assistantModel=document.querySelector('#assistant-model'),assistantRemember=document.querySelector('#assistant-remember'),assistantStatus=document.querySelector('#assistant-status');
let assistantInfo;
function showAssistantInfo(info){
  assistantInfo=info;assistantFields.disabled=info.mode!=='local';assistantRemember.disabled=!info.canRemember;assistantRemember.checked=info.remember;assistantModel.value=info.model;
  document.querySelector('#assistant-remote').hidden=info.mode!=='remote';
  document.querySelector('#assistant-clear').disabled=!info.configured&&info.keySource==='disabled';
  document.querySelector('#assistant-key-status').textContent=info.warning||(info.configured?(info.remember?'An API key is saved using protected OS storage.':info.keySource==='environment'?'An API key is configured through the desktop environment.':'An API key is configured for this session.'):'No API key is configured for this desktop.');
}
async function saveAssistant(clear){
  assistantFields.disabled=true;submit.disabled=true;assistantStatus.textContent=clear?'Removing API key…':'Saving assistant settings…';
  try{
    const key=assistantKey.value.trim();
    const result=await window.neoConnection.configureAssistant({keyAction:clear?'clear':key?'replace':'keep',...(!clear&&key?{apiKey:key}:{}),model:assistantModel.value.trim(),remember:!clear&&assistantRemember.checked});
    if(result.error)assistantStatus.textContent=result.error;
    else {showAssistantInfo(result);assistantStatus.textContent=clear?'API key removed. Inherited environment keys will remain disabled on the next launch.':'Assistant settings saved. No diagnostic evidence has been sent.';}
  }catch{assistantStatus.textContent='Assistant settings could not be saved. Try opening settings again.';}
  finally{assistantKey.value='';assistantFields.disabled=assistantInfo?.mode!=='local';submit.disabled=false;}
}
assistantForm.addEventListener('submit',event=>{event.preventDefault();void saveAssistant(false);});
document.querySelector('#assistant-clear').addEventListener('click',()=>void saveAssistant(true));
void window.neoConnection.assistantInfo().then(showAssistantInfo).catch(()=>{assistantStatus.textContent='Assistant settings could not be loaded. Close this window and open it again.';});
