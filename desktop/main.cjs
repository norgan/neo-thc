const {app,BrowserWindow,Menu,ipcMain,utilityProcess,dialog,safeStorage,shell}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const setupUrl=pathToFileURL(path.join(__dirname,'connection.html')).href;
let backend,mainWindow,setupWindow,closing=false,switching=false,current={mode:'local'},chosenCa='',smokeFailure;
const smokeFile=process.env.NEO_DESKTOP_SMOKE_FILE;
const automated=!!smokeFile||process.env.NEO_DESKTOP_AUTOMATION==='1';
if(smokeFile)app.disableHardwareAcceleration();
if(process.env.NEO_DESKTOP_USER_DATA)app.setPath('userData',path.resolve(process.env.NEO_DESKTOP_USER_DATA));
const profile=()=>path.join(app.getPath('userData'),'connection.json');
const database=()=>path.join(app.getPath('userData'),'neo.sqlite');
function encryptedStorage(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
function setupSender(event){if(!setupWindow||event.sender!==setupWindow.webContents||event.senderFrame!==setupWindow.webContents.mainFrame||event.senderFrame.url!==setupUrl)throw new Error('Unrecognized setup window');}
function lockWindow(win,allowed){
  win.webContents.setWindowOpenHandler(({url})=>{if(url==='http://127.0.0.1:4318/playback-guide'||/^https:\/\/(?:help\.netflix\.com\/en\/node\/(?:30081|306)|support\.google\.com\/youtube\/answer\/78358)(?:\?.*)?$/.test(url))void shell.openExternal(url);return {action:'deny'};});
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
  const child=utilityProcess.fork(path.join(__dirname,'backend.cjs'),[],{cwd:root,execArgv:[],stdio:'pipe',serviceName:'NEO collector',env:{SystemRoot:process.env.SystemRoot||'C:\\Windows',PATH:process.env.PATH||'',HOME:app.getPath('home'),TMP:app.getPath('temp'),TEMP:app.getPath('temp')}});backend=child;
  if(automated&&config.mode==='local'){let bytes=0;child.stderr?.on('data',chunk=>{bytes+=chunk.length;if(bytes<4096)console.error('Collector test stderr:',chunk.toString());});}
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('NEO startup timed out.')),15000);
    child.once('message',m=>{clearTimeout(timer);if(!m.ready)smokeFailure={stage:m.stage,detail:m.detail};m.ready?resolve():reject(new Error(m.error||'NEO startup failed.'));});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('NEO collector stopped during startup.'));});
    child.postMessage({...config,root,database:database(),smoke:!!smokeFile});
  });
  child.once('exit',()=>{if(backend===child&&!closing&&!switching){backend=null;dialog.showErrorBox('NEO collector stopped','Local collection stopped. Restart NEO to reconnect; displayed evidence may be out of date.');}});
}
function openSetup(){
  if(setupWindow){setupWindow.focus();return;}
  setupWindow=new BrowserWindow({width:650,height:760,parent:mainWindow,modal:!!mainWindow,show:!automated,webPreferences:{preload:path.join(__dirname,'connection-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  lockWindow(setupWindow,url=>url===setupUrl);setupWindow.on('closed',()=>setupWindow=null);void setupWindow.loadURL(setupUrl);
}
ipcMain.handle('neo:connection-info',event=>{setupSender(event);return {mode:current.mode,origin:current.origin||'',canRemember:encryptedStorage(),caSelected:!!chosenCa};});
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
ipcMain.handle('neo:open-connection',event=>{if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||new URL(event.senderFrame.url).origin!=='http://127.0.0.1:4318')throw new Error('Unrecognized desktop window');openSetup();});
ipcMain.handle('neo:open-companion',async event=>{if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Unrecognized desktop window');return shell.openPath(path.join(root,'browser-companion'));});
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{mainWindow?.show();mainWindow?.focus();});
  app.whenReady().then(async()=>{
    try{
      await fs.mkdir(app.getPath('userData'),{recursive:true});
      try{const saved=JSON.parse(await fs.readFile(profile(),'utf8'));if(saved.mode==='remote'&&saved.encryptedToken&&encryptedStorage()){current={mode:'remote',origin:saved.origin,token:safeStorage.decryptString(Buffer.from(saved.encryptedToken,'base64')),caPath:saved.caPath};chosenCa=saved.caPath||'';}}catch{}
      mainWindow=new BrowserWindow({title:'NEO THC',width:1280,height:900,minWidth:800,minHeight:600,show:!automated,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      lockWindow(mainWindow,url=>{try{return new URL(url).origin==='http://127.0.0.1:4318';}catch{return false;}});
      Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'NEO THC',submenu:[{label:'Desktop connection…',click:openSetup},{label:'Browser companion folder',click:()=>void shell.openPath(path.join(root,'browser-companion'))},{type:'separator'},{role:'quit'}]},{label:'View',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
      await startBackend(current);await mainWindow.loadURL('http://127.0.0.1:4318/');
      if(smokeFile){await fs.writeFile(smokeFile,JSON.stringify({started:true,electron:process.versions.electron,node:process.versions.node,mode:current.mode,url:mainWindow.webContents.getURL(),database:database()}));await fs.writeFile(smokeFile+'.png',(await mainWindow.webContents.capturePage()).toPNG());app.quit();}
    }catch(error){if(smokeFile)await fs.writeFile(smokeFile,JSON.stringify({started:false,error:error.message,backend:smokeFailure}));else if(automated)console.error('Desktop automation startup failed:',String(error.message).slice(0,1000));else dialog.showErrorBox('NEO could not start','Close any existing NEO server on port 4318 and launch again. If a saved server is unavailable, remove connection.json from the NEO user-data folder to return to standalone mode.');app.quit();}
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void stopBackend().catch(()=>{if(!smokeFile)dialog.showErrorBox('Shutdown needs attention','Collector shutdown was not confirmed. Restart the computer before running another NEO collector.');}).finally(()=>app.quit());});
}
