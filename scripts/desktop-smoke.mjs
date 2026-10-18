import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
const executable=resolve(process.argv[2]??'release/win-unpacked/NEO THC.exe');
const output=process.env.NEO_DESKTOP_PROOF_DIR?resolve(process.env.NEO_DESKTOP_PROOF_DIR):null;
const dir=await mkdtemp(join(tmpdir(),'neo-desktop-'));const proof=join(dir,'smoke.json');
let child;
try{
  const occupied=await fetch('http://127.0.0.1:4318/api/v1/health',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false);assert.equal(occupied,false,'Close another NEO instance before desktop smoke.');
  child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',PATH:process.env.PATH??'',USERPROFILE:process.env.USERPROFILE??'',APPDATA:process.env.APPDATA??'',LOCALAPPDATA:process.env.LOCALAPPDATA??'',TMP:tmpdir(),TEMP:tmpdir(),NEO_DESKTOP_USER_DATA:join(dir,'profile'),NEO_DESKTOP_SMOKE_FILE:proof}});
  let exited=false,code=null;child.once('exit',value=>{exited=true;code=value;});child.once('error',()=>{exited=true;code=1;});
  const deadline=Date.now()+(process.argv.includes('--portable')?180000:60000);while(!exited&&Date.now()<deadline)await delay(200);
  assert.ok(exited,'Packaged desktop did not finish its bounded smoke test');assert.equal(code,0);
  const data=JSON.parse(await readFile(proof,'utf8'));if(!data.started)console.error(JSON.stringify(data));assert.equal(data.started,true);assert.equal(data.rendered,true);assert.equal(data.mode,'local');assert.ok(data.node.startsWith('24.'));assert.equal(data.url,'http://127.0.0.1:4318/');
  const db=new DatabaseSync(data.database,{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);db.close();
  assert.equal(await fetch('http://127.0.0.1:4318/api/v1/health',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false),false,'Desktop must close its owned listener');
  if(output){await (await import('node:fs/promises')).mkdir(output,{recursive:true});await writeFile(join(output,'desktop-smoke.json'),JSON.stringify({...data,database:'isolated temporary profile; removed after verification'},null,2));if(data.screenshot==='saved')await writeFile(join(output,'desktop-smoke.png'),await readFile(proof+'.png'));}
  console.log('PASS: actual packaged desktop starts its own collector, renders packaged UI, creates schema 3, exits and closes its listener. No external Node installation is used by the app.');
}finally{if(child?.exitCode===null)child.kill();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+(process.platform==='win32'?'\\':'/')));await rm(dir,{recursive:true,force:true});}
