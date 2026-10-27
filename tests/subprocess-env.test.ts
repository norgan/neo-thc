import test from 'node:test';
import assert from 'node:assert/strict';
import {subprocessEnvironment} from '../server/subprocess-env.js';
import {command} from '../server/internet-network.mjs';

test('native environment strips protected credential names case-insensitively without changing unrelated settings',()=>{
  const source={NEO_OPENAI_API_KEY:'fixture-key',openai_api_key:'fixture-key',Neo_Service_Token:'fixture-token',PATH:'/fixture/bin',SystemRoot:'C:\\Windows',HOME:'/fixture/home',NEO_DNS_BENCH_PATH:'/fixture/dns-bench',LC_ALL:'C'};
  const environment=subprocessEnvironment(source);
  assert.deepEqual(environment,{PATH:'/fixture/bin',SystemRoot:'C:\\Windows',HOME:'/fixture/home',NEO_DNS_BENCH_PATH:'/fixture/dns-bench',LC_ALL:'C'});
  assert.equal(source.NEO_OPENAI_API_KEY,'fixture-key');assert.notEqual(environment,source);
});

test('fixed local configuration commands already exclude collector API credentials',async()=>{
  const names=['NEO_OPENAI_API_KEY','OPENAI_API_KEY'] as const,before=names.map(name=>process.env[name]);
  for(const name of names)process.env[name]='fixture-key-must-stay-in-parent';
  try{
    const result=await command(process.execPath,['-e',"process.stdout.write(Object.keys(process.env).some(name=>['NEO_OPENAI_API_KEY','OPENAI_API_KEY'].includes(name.toUpperCase()))?'present':'absent')"],new AbortController().signal,3000);
    assert.equal(result,'absent');assert.ok(names.every(name=>process.env[name]==='fixture-key-must-stay-in-parent'));
  }finally{names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});}
});
