import {_electron as electron,expect} from '@playwright/test';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {createApp} from '../dist/server/server/app.js';
const directory=await mkdtemp(join(tmpdir(),'neo-desktop-integration-'));let desktop,server;
let protectedAssistantStorage=false;
try{
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',key,'-out',cert],{timeout:10000,maxBuffer:8192});
  const token=randomBytes(32).toString('base64url');const access={mode:'service',origin:'https://127.0.0.1:7443',token};
  server=createApp({access,tls:{key:await readFile(key),cert:await readFile(cert)}}).app;await server.listen({host:'127.0.0.1',port:0});access.origin='https://127.0.0.1:'+server.server.address().port;
  const profile=join(directory,'profile');
  const environment={...process.env,NEO_DESKTOP_USER_DATA:profile};delete environment.ELECTRON_RUN_AS_NODE;delete environment.NEO_OPENAI_API_KEY;delete environment.OPENAI_API_KEY;delete environment.NEO_OPENAI_MODEL;
  // Playwright gates app-ready only when it owns its loader. Exercise the exact packaged
  // application files with the same pinned Electron runtime; desktop-smoke covers the EXE.
  desktop=await electron.launch({args:[resolve('release/win-unpacked/resources/app')],chromiumSandbox:true,env:environment,timeout:30000});
  const page=await desktop.firstWindow();await page.waitForURL('http://127.0.0.1:4318/');await expect(page.getByText('playback-desktop-v7',{exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>typeof window.neoConnection),'undefined','Main renderer must not receive connection credential APIs');
  await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();
  await desktop.evaluate(({shell})=>{shell.openPath=async folder=>{globalThis.__neoCompanionFolder=folder;return '';};});
  await page.getByRole('button',{name:'Open browser companion folder',exact:true}).click();
  const companionFolder=join(profile,'browser-companion-0.2.1');await expect.poll(()=>desktop.evaluate(()=>globalThis.__neoCompanionFolder)).toBe(companionFolder);
  assert.equal(JSON.parse(await readFile(join(companionFolder,'manifest.json'),'utf8')).version,'0.2.1');
  const newWindow=desktop.waitForEvent('window');await page.getByRole('button',{name:'Desktop connection',exact:true}).click();const connection=await newWindow;await connection.waitForLoadState();
  const assistantKey='sk-neotest-desktop-'+randomBytes(16).toString('hex');
  assert.equal((await page.evaluate(()=>fetch('/api/v1/assistant/options').then(r=>r.json()))).available,false);
  await connection.getByLabel('OpenAI API key',{exact:true}).fill(assistantKey);
  await connection.getByLabel('OpenAI model (optional)',{exact:true}).fill('gpt-6.1-sol');
  await connection.getByRole('button',{name:'Save assistant settings',exact:true}).click();
  await expect(connection.getByText('Assistant settings saved. No diagnostic evidence has been sent.',{exact:true})).toBeVisible({timeout:15000});
  await expect(connection.getByLabel('OpenAI API key',{exact:true})).toHaveValue('');
  const assistantOptions=await page.evaluate(()=>fetch('/api/v1/assistant/options').then(r=>r.json()));
  assert.equal(assistantOptions.available,true);assert.equal(assistantOptions.model,'gpt-6.1-sol');assert.equal(JSON.stringify(assistantOptions).includes(assistantKey),false);
  assert.equal(JSON.stringify(await connection.evaluate(()=>window.neoConnection.assistantInfo())).includes(assistantKey),false);
  assert.equal(JSON.stringify(await page.evaluate(()=>fetch('/api/v1/snapshot').then(r=>r.json()))).includes(assistantKey),false);
  assert.equal((await readFile(join(profile,'assistant.json'),'utf8')).includes(assistantKey),false);
  assert.equal(JSON.parse(await readFile(join(profile,'assistant.json'),'utf8')).keySource,'disabled');
  // Exercise the actual platform encryption when available. Never make an API call.
  const rememberAssistant=connection.getByLabel('Remember the API key using protected OS credential storage',{exact:true});
  if(!await rememberAssistant.isDisabled()){
    await rememberAssistant.check();await connection.getByRole('button',{name:'Save assistant settings',exact:true}).click();
    await expect(connection.getByText('An API key is saved using protected OS storage.',{exact:true})).toBeVisible();
    const encrypted=JSON.parse(await readFile(join(profile,'assistant.json'),'utf8'));
    assert.equal(encrypted.keySource,'desktop');assert.equal(JSON.stringify(encrypted).includes(assistantKey),false);
    assert.equal(await desktop.evaluate(({safeStorage},{cipher,key})=>safeStorage.decryptString(Buffer.from(cipher,'base64'))===key,{cipher:encrypted.encryptedApiKey,key:assistantKey}),true);
    protectedAssistantStorage=true;
    await rememberAssistant.uncheck();await connection.getByRole('button',{name:'Save assistant settings',exact:true}).click();
    await expect(connection.getByText('An API key is configured for this session.',{exact:true})).toBeVisible();
    assert.equal(JSON.parse(await readFile(join(profile,'assistant.json'),'utf8')).keySource,'disabled');
  }
  await desktop.evaluate(({dialog},ca)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[ca]});},cert);
  await connection.getByLabel('Run NEO').selectOption('remote');await connection.getByLabel('Server HTTPS origin').fill(access.origin);await connection.getByLabel('Server access token',{exact:true}).fill(token);await connection.getByRole('button',{name:'Choose private CA certificate (optional)'}).click();await expect(connection.getByText('Private CA selected.',{exact:false})).toBeVisible();
  await connection.getByRole('button',{name:'Apply connection',exact:true}).click();await expect(page.getByText('Remote collector',{exact:false})).toBeVisible({timeout:15000});
  const placement=await page.evaluate(()=>fetch('/api/v1/placement').then(r=>r.json()));assert.equal(placement.mode,'remote');assert.equal(placement.deviceChecks,'this-computer');
  const remoteAssistant=await page.evaluate(()=>fetch('/api/v1/assistant/options').then(r=>r.json()));
  const serviceAssistant=(await server.inject({url:'/api/v1/assistant/options',headers:{host:new URL(access.origin).host,authorization:'Bearer '+token}})).json();
  assert.deepEqual(remoteAssistant,serviceAssistant,'Remote assistant configuration belongs to the selected service');assert.equal(JSON.stringify(remoteAssistant).includes(assistantKey),false);
  assert.ok(!(await readFile(join(profile,'connection.json'),'utf8')).includes(token));
  if(process.env.NEO_DESKTOP_PROOF_DIR){await mkdir(process.env.NEO_DESKTOP_PROOF_DIR,{recursive:true});await page.screenshot({path:join(process.env.NEO_DESKTOP_PROOF_DIR,'desktop-remote-mode.png')});}
  await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();const backWindow=desktop.waitForEvent('window');await page.getByRole('button',{name:'Desktop connection',exact:true}).click();const back=await backWindow;await back.waitForLoadState();
  await expect(back.getByLabel('OpenAI API key',{exact:true})).toBeDisabled();
  assert.ok((await back.evaluate(()=>window.neoConnection.configureAssistant({keyAction:'clear',model:'',remember:false}))).error.includes('remote collector'));
  await back.getByLabel('Run NEO').selectOption('local');await back.getByRole('button',{name:'Apply connection',exact:true}).click();await expect(page.getByText('Local home tech support',{exact:false})).toBeVisible({timeout:15000});
  assert.equal((await page.evaluate(()=>fetch('/api/v1/assistant/options').then(r=>r.json()))).available,true,'Standalone session key survives switching through a remote collector');
  const clearWindow=desktop.waitForEvent('window');await page.evaluate(()=>window.neoDesktop.connection('assistant'));const clear=await clearWindow;await clear.waitForLoadState();assert.ok(clear.url().endsWith('#assistant-heading'));
  await clear.getByRole('button',{name:'Remove API key',exact:true}).click();await expect(clear.getByText('API key removed. Inherited environment keys will remain disabled on the next launch.',{exact:true})).toBeVisible({timeout:15000});
  assert.equal((await page.evaluate(()=>fetch('/api/v1/assistant/options').then(r=>r.json()))).available,false);
  assert.equal(JSON.parse(await readFile(join(profile,'assistant.json'),'utf8')).keySource,'disabled');
  await desktop.close();desktop=null;assert.equal(await fetch('http://127.0.0.1:4318/api/v1/health',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false),false);
  assert.equal(JSON.parse(await readFile(join(companionFolder,'manifest.json'),'utf8')).version,'0.2.1','Companion files survive desktop shutdown');
  if(process.env.NEO_DESKTOP_PROOF_DIR)await writeFile(join(process.env.NEO_DESKTOP_PROOF_DIR,'desktop-modes.json'),JSON.stringify({standalone:true,persistentCompanionFolder:true,remoteTLS:true,privateCA:true,tokenOutsideRenderer:true,sessionOnlyTokenNotPersisted:true,returnToStandalone:true,assistantSessionKeyOutsideRenderer:true,assistantSessionKeyNotPersisted:true,protectedAssistantStorage,remoteAssistantUsesServiceConfiguration:true,assistantKeyRemoved:true,noOpenAIInferenceRequests:true,ownedListenerClosed:true},null,2));
  console.log('PASS: actual desktop Settings IPC switches standalone → verified private-CA TLS service → standalone; credentials stay outside the main renderer; assistant configuration, session-only and protected storage, remote isolation and key removal pass; no OpenAI inference is requested; shutdown closes listener.');
}finally{await desktop?.close();await server?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+requireSeparator()));await rm(directory,{recursive:true,force:true});}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
