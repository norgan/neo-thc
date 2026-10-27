// Only the Electron main process and its isolated setup window handle credentials.
// This module never reads environment variables, starts a request, or logs secrets.
function modelName(value){
  if(typeof value!=='string')throw new Error('Enter an OpenAI model name, or leave it blank for the default.');
  const model=value.trim();
  if(model&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model))throw new Error('Enter a valid OpenAI model name.');
  return model;
}
function apiKey(value){
  if(typeof value!=='string')throw new Error('Enter an OpenAI API key.');
  const key=value.trim();
  if(!/^[A-Za-z0-9._-]{20,512}$/.test(key))throw new Error('Enter a valid OpenAI API key without spaces.');
  return key;
}
function updateAssistantConfig(current,input,canRemember){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['keyAction','apiKey','model','remember'].includes(key)))throw new Error('Invalid assistant settings.');
  if(!['keep','replace','clear'].includes(input.keyAction)||typeof input.remember!=='boolean')throw new Error('Invalid assistant settings.');
  if(input.keyAction!=='replace'&&input.apiKey!==undefined&&input.apiKey!=='')throw new Error('Choose Replace before entering an API key.');
  const key=input.keyAction==='replace'?apiKey(input.apiKey):input.keyAction==='clear'?'':current.apiKey;
  const model=modelName(input.model);
  const remember=input.keyAction==='clear'?false:input.remember;
  if(remember&&(!key||!canRemember))throw new Error(!key?'Enter an API key before choosing Remember.':'Protected credential storage is unavailable. Leave Remember unchecked.');
  const keySource=input.keyAction==='clear'?'disabled':input.keyAction==='replace'||remember?'desktop':current.keySource;
  return {apiKey:key,model,remember,keySource};
}
function savedAssistantConfig(config,storage){
  const saved={version:1,model:modelName(config.model),keySource:config.keySource==='environment'&&!config.remember?'environment':'disabled'};
  if(config.remember){
    if(!storage.available)throw new Error('Protected credential storage is unavailable. Leave Remember unchecked.');
    saved.encryptedApiKey=storage.encrypt(apiKey(config.apiKey)).toString('base64');
    saved.keySource='desktop';
  }
  return saved;
}
function environmentAssistantConfig(environment){
  const candidate=environment.NEO_OPENAI_API_KEY??environment.OPENAI_API_KEY??'';
  return {apiKey:candidate?apiKey(candidate):'',model:modelName(environment.NEO_OPENAI_MODEL??''),remember:false,keySource:'environment'};
}
function restoredAssistantConfig(saved,storage,environment={}){
  if(!saved||typeof saved!=='object'||Array.isArray(saved)||saved.version!==1||Object.keys(saved).some(key=>!['version','model','keySource','encryptedApiKey'].includes(key))||!['environment','desktop','disabled'].includes(saved.keySource))throw new Error('Saved assistant settings could not be read.');
  const config={apiKey:saved.keySource==='environment'?environmentAssistantConfig(environment).apiKey:'',model:modelName(saved.model),remember:false,keySource:saved.keySource};
  if(saved.encryptedApiKey!==undefined){
    if(saved.keySource!=='desktop')throw new Error('Saved assistant credentials could not be read.');
    if(typeof saved.encryptedApiKey!=='string'||saved.encryptedApiKey.length>8192||!saved.encryptedApiKey||!/^[A-Za-z0-9+/]+={0,2}$/.test(saved.encryptedApiKey))throw new Error('Saved assistant credentials could not be read.');
    if(!storage.available)throw new Error('Protected credential storage is unavailable. Enter the API key again for this session.');
    config.apiKey=apiKey(storage.decrypt(Buffer.from(saved.encryptedApiKey,'base64')));config.remember=true;
  }
  if(saved.keySource==='desktop'&&!config.apiKey)throw new Error('Saved assistant credentials could not be read.');
  return config;
}
function assistantEnvironment(mode,config){
  if(mode!=='local')return {};
  return {...(config.apiKey?{NEO_OPENAI_API_KEY:config.apiKey}:{}),...(config.model?{NEO_OPENAI_MODEL:config.model}:{})};
}
function assistantInfo(config,canRemember,mode,warning=''){
  return {configured:!!config.apiKey,model:config.model,remember:config.remember,keySource:config.keySource,canRemember,mode,warning};
}
module.exports={updateAssistantConfig,savedAssistantConfig,restoredAssistantConfig,environmentAssistantConfig,assistantEnvironment,assistantInfo};
