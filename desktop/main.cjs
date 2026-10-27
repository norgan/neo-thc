const {app,BrowserWindow,Menu,ipcMain,utilityProcess,dialog,safeStorage,shell,nativeTheme}=require('electron');
nativeTheme.themeSource='dark';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {updateAssistantConfig,savedAssistantConfig,restoredAssistantConfig,environmentAssistantConfig,assistantEnvironment,assistantInfo}=require('./assistant-config.cjs');
const root=path.join(__dirname,'..');
const setupUrl=pathToFileURL(path.join(__dirname,'connection.html')).href;
const assistantSetupUrl=setupUrl+'#assistant-heading';
const isSetupUrl=url=>url===setupUrl||url===assistantSetupUrl;
let backend,mainWindow,setupWindow,closing=false,switching=false,current={mode:'local'},chosenCa='',smokeFailure;
let assistant={apiKey:'',model:'',remember:false,keySource:'environment'},assistantWarning='';
const smokeFile=process.env.NEO_DESKTOP_SMOKE_FILE;
const automated=!!smokeFile||process.env.NEO_DESKTOP_AUTOMATION==='1';
if(smokeFile)app.disableHardwareAcceleration();
if(process.env.NEO_DESKTOP_USER_DATA)app.setPath('userData',path.resolve(process.env.NEO_DESKTOP_USER_DATA));
const profile=()=>path.join(app.getPath('userData'),'connection.json');
const assistantProfile=()=>path.join(app.getPath('userData'),'assistant.json');
const database=()=>path.join(app.getPath('userData'),'neo.sqlite');
async function openCompanionFolder(){
  // A portable executable extracts into a temporary directory. Browser extensions
  // must be installed from a persistent, versioned copy that survives app shutdown.
  const folder=path.join(app.getPath('userData'),'browser-companion-'+app.getVersion());
  await fs.mkdir(folder,{recursive:true});
  for(const name of ['manifest.json','background.js','sampler.js','popup.html','popup.js','popup.css']){
    try{await fs.copyFile(path.join(root,'browser-companion',name),path.join(folder,name),constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  return shell.openPath(folder);
}
function encryptedStorage(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
function assistantStorage(){return {available:encryptedStorage(),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)};}
async function writeAssistantProfile(saved){
  const temporary=assistantProfile()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(saved),{mode:0o600});await fs.rename(temporary,assistantProfile());}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function setupSender(event){if(!setupWindow||event.sender!==setupWindow.webContents||event.senderFrame!==setupWindow.webContents.mainFrame||!isSetupUrl(event.senderFrame.url))throw new Error('Unrecognized setup window');}
function lockWindow(win,allowed){
  win.webContents.setWindowOpenHandler(({url})=>{if(url==='http://127.0.0.1:4318/playback-guide'||url==='https://platform.openai.com/api-keys'||/^https:\/\/(?:help\.netflix\.com\/en\/node\/(?:30081|306)|support\.google\.com\/youtube\/answer\/78358)(?:\?.*)?$/.test(url))void shell.openExternal(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
}
async function stopBackend(){
  const child=backend;if(!child)return;backend=null;
  await new Promise((resolve,reject)=>{
    let done=false;let cleanup;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(cleanup);resolve();};
    child.once('exit',finish);
    const timer=setTimeout(()=>{child.kill();cleanup=setTimeout(()=>{if(!done)reject(new Error('Collector shutdown was not confirmed. Restart NEO before collecting again.'));},2000);},8000);
    child.postMessage({shutdown:true});
  });
}
async function startBackend(config){
  const child=utilityProcess.fork(path.join(__dirname,'backend.cjs'),[],{cwd:root,execArgv:[],stdio:'pipe',serviceName:'NEO collector',env:{SystemRoot:process.env.SystemRoot||'C:\\Windows',PATH:process.env.PATH||'',HOME:app.getPath('home'),TMP:app.getPath('temp'),TEMP:app.getPath('temp'),...assistantEnvironment(config.mode,assistant)}});backend=child;
  if(automated&&config.mode==='local'){let bytes=0;child.stderr?.on('data',chunk=>{bytes+=chunk.length;if(bytes<4096)console.error('Collector test stderr:',chunk.toString());});}
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('NEO startup timed out.')),15000);
    child.once('message',m=>{clearTimeout(timer);if(!m.ready)smokeFailure={stage:m.stage,detail:m.detail};m.ready?resolve():reject(new Error(m.error||'NEO startup failed.'));});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('NEO collector stopped during startup.'));});
    child.postMessage({...config,root,database:database(),smoke:!!smokeFile});
  });
  child.once('exit',()=>{if(backend===child&&!closing&&!switching){backend=null;dialog.showErrorBox('NEO collector stopped','Local collection stopped. Restart NEO to reconnect; displayed evidence may be out of date.');}});
}
function openSetup(section){
  if(setupWindow){setupWindow.focus();return;}
  setupWindow=new BrowserWindow({width:650,height:760,backgroundColor:'#050b14',parent:mainWindow,modal:!!mainWindow,show:!automated,webPreferences:{preload:path.join(__dirname,'connection-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  lockWindow(setupWindow,isSetupUrl);setupWindow.on('closed',()=>setupWindow=null);void setupWindow.loadURL(section==='assistant'?assistantSetupUrl:setupUrl);
}
ipcMain.handle('neo:connection-info',event=>{setupSender(event);return {mode:current.mode,origin:current.origin||'',canRemember:encryptedStorage(),caSelected:!!chosenCa};});
ipcMain.handle('neo:assistant-info',event=>{setupSender(event);return assistantInfo(assistant,encryptedStorage(),current.mode,assistantWarning);});
ipcMain.handle('neo:assistant-configure',async(event,input)=>{
  setupSender(event);if(switching)return {error:'A settings change is already in progress.'};
  if(current.mode!=='local')return {error:'The remote collector uses its own OpenAI configuration. Return to standalone to configure this desktop.'};
  switching=true;
  let saved=false;
  try{
    const next=updateAssistantConfig(assistant,input,encryptedStorage());
    const persisted=savedAssistantConfig(next,assistantStorage());
    await writeAssistantProfile(persisted);
    const restart=next.apiKey!==assistant.apiKey||next.model!==assistant.model;
    assistant=next;assistantWarning='';saved=true;
    if(restart){await stopBackend();await startBackend(current);await mainWindow.loadURL('http://127.0.0.1:4318/');}
    return {ok:true,...assistantInfo(assistant,encryptedStorage(),current.mode)};
  }catch(error){return {error:saved?'Assistant settings were saved, but the local collector could not restart. Close NEO and reopen it before collecting. Session-only keys need to be entered again.':error.message||'Assistant settings could not be saved.'};}finally{switching=false;}
});
ipcMain.handle('neo:choose-ca',async event=>{setupSender(event);const result=await dialog.showOpenDialog(setupWindow,{title:'Choose the server certificate authority',properties:['openFile'],filters:[{name:'CA certificate',extensions:['pem','crt','cer']}]});if(!result.canceled){const stat=await fs.stat(result.filePaths[0]);if(stat.size>1048576)throw new Error('CA certificate is too large.');chosenCa=result.filePaths[0];}return !!chosenCa;});
ipcMain.handle('neo:connect',async(event,input)=>{
  setupSender(event);if(switching)return {error:'A connection change is already in progress.'};switching=true;
  try{
    if(!input||!['local','remote'].includes(input.mode))throw new Error('Choose a connection mode.');
    const config={mode:input.mode};
    if(input.mode==='remote'){
      const {serviceOrigin,validToken}=await import(pathToFileURL(path.join(root,'dist/server/server/access.js')).href);
      if(!validToken(input.token))throw new Error('Enter the server access token.');config.origin=serviceOrigin(input.origin).origin;config.token=input.token;if(chosenCa)config.caPath=chosenCa;
      const {remoteRequest}=await import(pathToFileURL(path.join(root,'dist/server/server/frontend.js')).href);
      const result=await remoteRequest({...config,...(chosenCa?{ca:await fs.readFile(chosenCa)}:{})},'GET','/api/v1/health',undefined,AbortSignal.timeout(8000));
      if(result.status!==200||result.body?.runtime!=='playback-desktop-v7')throw new Error('The server did not authenticate or runs an incompatible NEO build.');
      if(input.remember&&!encryptedStorage())throw new Error('Protected credential storage is unavailable. Leave Remember unchecked.');
    }
    await stopBackend();await startBackend(config);current=config;
    await fs.mkdir(app.getPath('userData'),{recursive:true});
    const saved=input.mode==='remote'&&input.remember?{mode:'remote',origin:config.origin,caPath:config.caPath,encryptedToken:safeStorage.encryptString(config.token).toString('base64')}:{mode:'local'};
    await fs.writeFile(profile(),JSON.stringify(saved),{mode:0o600});
    await mainWindow.loadURL('http://127.0.0.1:4318/');setupWindow?.close();return {ok:true};
  }catch(error){return {error:error.message||'Connection could not be changed.'};}finally{switching=false;}
});
ipcMain.handle('neo:open-connection',(event,section)=>{if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||new URL(event.senderFrame.url).origin!=='http://127.0.0.1:4318')throw new Error('Unrecognized desktop window');if(section!==undefined&&section!=='assistant')throw new Error('Unknown desktop settings section');openSetup(section);});
ipcMain.handle('neo:open-companion',async event=>{if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Unrecognized desktop window');return openCompanionFolder();});
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{mainWindow?.show();mainWindow?.focus();});
  app.whenReady().then(async()=>{
    try{
      await fs.mkdir(app.getPath('userData'),{recursive:true});
      try{assistant=restoredAssistantConfig(JSON.parse(await fs.readFile(assistantProfile(),'utf8')),assistantStorage(),process.env);}catch(error){
        if(error.code==='ENOENT'){try{assistant=environmentAssistantConfig(process.env);}catch{assistantWarning='OpenAI environment configuration could not be used. Enter a valid API key and model in Assistant settings.';}}
        else assistantWarning='Saved assistant settings could not be opened. Enter the API key again; the existing saved file is unchanged until you apply settings.';
      }
      try{const saved=JSON.parse(await fs.readFile(profile(),'utf8'));if(saved.mode==='remote'&&saved.encryptedToken&&encryptedStorage()){current={mode:'remote',origin:saved.origin,token:safeStorage.decryptString(Buffer.from(saved.encryptedToken,'base64')),caPath:saved.caPath};chosenCa=saved.caPath||'';}}catch{}
      mainWindow=new BrowserWindow({title:'NEO THC',width:1280,height:900,minWidth:800,minHeight:600,backgroundColor:'#050b14',show:!automated,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      lockWindow(mainWindow,url=>{try{return new URL(url).origin==='http://127.0.0.1:4318';}catch{return false;}});
      Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'NEO THC',submenu:[{label:'Desktop connection…',click:()=>openSetup()},{label:'Assistant settings…',click:()=>openSetup('assistant')},{label:'Browser companion folder',click:()=>void openCompanionFolder()},{type:'separator'},{role:'quit'}]},{label:'View',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
      await startBackend(current);await mainWindow.loadURL('http://127.0.0.1:4318/');
      if(smokeFile){
        let rendered=false;for(let attempt=0;attempt<20&&!rendered;attempt++){rendered=await mainWindow.webContents.executeJavaScript('!!document.querySelector("h1") && document.body.textContent.includes("playback-desktop-v7")');if(!rendered)await new Promise(resolve=>setTimeout(resolve,100));}
        if(!rendered)throw new Error('Packaged interface did not render before its deadline');
        let screenshot='unavailable';try{await fs.writeFile(smokeFile+'.png',(await mainWindow.webContents.capturePage()).toPNG());screenshot='saved';}catch{}
        await fs.writeFile(smokeFile,JSON.stringify({started:true,rendered,screenshot,electron:process.versions.electron,node:process.versions.node,mode:current.mode,url:mainWindow.webContents.getURL(),database:database()}));app.quit();
      }
    }catch(error){if(smokeFile)await fs.writeFile(smokeFile,JSON.stringify({started:false,error:error.message,backend:smokeFailure}));else if(automated)console.error('Desktop automation startup failed:',String(error.message).slice(0,1000));else dialog.showErrorBox('NEO could not start','Close any existing NEO server on port 4318 and launch again. If a saved server is unavailable, remove connection.json from the NEO user-data folder to return to standalone mode.');app.quit();}
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void stopBackend().catch(()=>{if(!smokeFile)dialog.showErrorBox('Shutdown needs attention','Collector shutdown was not confirmed. Restart the computer before running another NEO collector.');}).finally(()=>app.quit());});
}
