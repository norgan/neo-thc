import {parentPort,workerData} from 'node:worker_threads';
import {validateWirePlan} from './discovery-result.mjs';
import {resolveGlancesMdns} from './glances-mdns.mjs';
if(!parentPort||process.execArgv.length||Object.keys(process.env).length)throw new Error('worker');
const input=workerData;
if(!input||input.v!==1||typeof input.attemptId!=='string'||!/^[a-f0-9-]{36}$/.test(input.attemptId))throw new Error('worker');
const plan=validateWirePlan(input.plan);
if(!plan.glances||!plan.linkScopeConfirmed)throw new Error('scope');
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
try {
  const result=await resolveGlancesMdns(plan,controller.signal);
  parentPort.postMessage(JSON.stringify({v:1,attemptId:input.attemptId,result}));
} finally {clearTimeout(timer);}
