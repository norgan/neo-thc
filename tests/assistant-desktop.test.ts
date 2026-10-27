import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {updateAssistantConfig,savedAssistantConfig,restoredAssistantConfig,environmentAssistantConfig,assistantEnvironment,assistantInfo}=createRequire(import.meta.url)('../desktop/assistant-config.cjs');
const secret='sk-neotest-fixture-secret-never-send';
const otherSecret='sk-neotest-other-fixture-secret';
const empty={apiKey:'',model:'',remember:false,keySource:'environment'};
const unavailable={available:false,encrypt:()=>{throw new Error('Encryption must not run');},decrypt:()=>{throw new Error('Decryption must not run');}};
const replace={keyAction:'replace',apiKey:secret,model:'gpt-6.1-sol',remember:false};

test('desktop assistant session keys remain in trusted process memory and reach standalone only',()=>{
  const configured=updateAssistantConfig(empty,replace,false);
  assert.equal(configured.apiKey,secret);
  assert.deepEqual(assistantEnvironment('local',configured),{NEO_OPENAI_API_KEY:secret,NEO_OPENAI_MODEL:'gpt-6.1-sol'});
  assert.deepEqual(assistantEnvironment('remote',configured),{});
  assert.deepEqual(assistantEnvironment('anything-else',configured),{});
  const info=assistantInfo(configured,false,'local');
  assert.equal(info.configured,true);assert.equal(info.remember,false);
  assert.equal(JSON.stringify(info).includes(secret),false);assert.equal('apiKey' in info,false);
  const saved=savedAssistantConfig(configured,unavailable);
  assert.deepEqual(saved,{version:1,model:'gpt-6.1-sol',keySource:'disabled'});
  assert.equal(JSON.stringify(saved).includes(secret),false);
  const restored=restoredAssistantConfig(saved,unavailable,{OPENAI_API_KEY:otherSecret});
  assert.equal(restored.apiKey,'','Session-only desktop credentials do not silently fall back to an inherited key on relaunch');
});

test('desktop assistant persistence requires real protected storage and never creates plaintext credentials',()=>{
  let encryptCalls=0,decryptCalls=0;
  const protectedStorage={available:true,encrypt:(value:string)=>{encryptCalls++;assert.equal(value,secret);return Buffer.from('protected-fixture-ciphertext');},decrypt:(value:Buffer)=>{decryptCalls++;assert.equal(value.toString(),'protected-fixture-ciphertext');return secret;}};
  assert.throws(()=>updateAssistantConfig(empty,{...replace,remember:true},false),/Protected credential storage/);
  assert.throws(()=>savedAssistantConfig({...empty,apiKey:secret,remember:true},unavailable),/Protected credential storage/);
  const configured=updateAssistantConfig(empty,{...replace,remember:true},true);
  const saved=savedAssistantConfig(configured,protectedStorage);
  assert.equal(encryptCalls,1);assert.equal(saved.keySource,'desktop');assert.equal(JSON.stringify(saved).includes(secret),false);
  assert.equal('apiKey' in saved,false);
  const restored=restoredAssistantConfig(saved,protectedStorage);
  assert.equal(restored.apiKey,secret);assert.equal(restored.remember,true);assert.equal(decryptCalls,1);
  assert.throws(()=>restoredAssistantConfig(saved,unavailable),/Protected credential storage/);
  assert.throws(()=>restoredAssistantConfig({...saved,apiKey:secret},protectedStorage),/could not be read/);
});

test('desktop assistant respects environment precedence and an explicit clear stays disabled',()=>{
  const env={NEO_OPENAI_API_KEY:secret,OPENAI_API_KEY:otherSecret,NEO_OPENAI_MODEL:'gpt-6.1-sol'};
  const configured=environmentAssistantConfig(env);
  assert.equal(configured.apiKey,secret);assert.equal(configured.keySource,'environment');
  assert.equal(environmentAssistantConfig({OPENAI_API_KEY:otherSecret}).apiKey,otherSecret);
  assert.equal(environmentAssistantConfig({...env,NEO_OPENAI_API_KEY:''}).apiKey,'','An explicit empty NEO key overrides generic fallback');
  const saved=savedAssistantConfig(configured,unavailable);
  assert.equal(saved.keySource,'environment');assert.equal(JSON.stringify(saved).includes(secret),false);
  assert.equal(restoredAssistantConfig(saved,unavailable,{OPENAI_API_KEY:otherSecret}).apiKey,otherSecret);
  const cleared=updateAssistantConfig(configured,{keyAction:'clear',model:'',remember:true},false);
  assert.equal(cleared.apiKey,'');assert.equal(cleared.remember,false);assert.equal(cleared.keySource,'disabled');
  const restored=restoredAssistantConfig(savedAssistantConfig(cleared,unavailable),unavailable,env);
  assert.equal(restored.apiKey,'');assert.deepEqual(assistantEnvironment('local',restored),{});
});

test('desktop assistant rejects malformed settings and credentials without reflecting their contents',()=>{
  for(const input of [null,[],{}, {...replace,keyAction:'unknown'}, {...replace,endpoint:'https://example.invalid'}, {...replace,model:'../../config'}, {...replace,model:'gpt-6:secret'}, {...replace,remember:'yes'}, {...replace,apiKey:'short'}, {...replace,apiKey:secret+'\nsecret'}, {...replace,apiKey:secret+'/unapproved'}, {...replace,apiKey:'k'.repeat(513)}, {...replace,keyAction:'keep'}, {...replace,model:'g'.repeat(101)}]){
    assert.throws(()=>updateAssistantConfig(empty,input,true),(error:unknown)=>error instanceof Error&&!error.message.includes(secret));
  }
  assert.throws(()=>updateAssistantConfig(empty,{keyAction:'keep',model:'',remember:true},true),/Enter an API key/);
  for(const saved of [{version:1,model:'',keySource:'desktop'}, {version:1,model:'',keySource:'disabled',encryptedApiKey:'aGVsbG8='}, {version:1,model:'',keySource:'environment',apiKey:secret}, {version:1,model:'',keySource:'desktop',encryptedApiKey:'*invalid*'}])assert.throws(()=>restoredAssistantConfig(saved,unavailable));
});
