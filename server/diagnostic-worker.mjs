import {parentPort,workerData} from 'node:worker_threads';
import {dnsCheck,systemCheck,connectionCheck} from './diagnostic-network.mjs';

const {attemptId,plan}=workerData;
/** @param {unknown} result @param {number} index */
const send=(result,index)=>parentPort?.postMessage(JSON.stringify({v:1,attemptId,type:'result',index,result}));
let index=0;
if(plan.kind==='dns'){
  for(const source of plan.resolvers)for(const recordType of ['A','AAAA'])send(await dnsCheck(plan.hostname,source,/** @type {'A'|'AAAA'} */(recordType),plan.port??53),index++);
  if(plan.systemLookup)send(await systemCheck(plan.hostname),index++);
}else{
  for(const address of plan.addresses)send(await connectionCheck(plan.hostname,address,plan.port,plan.tls),index++);
}
parentPort?.postMessage(JSON.stringify({v:1,attemptId,type:'done',count:index}));
