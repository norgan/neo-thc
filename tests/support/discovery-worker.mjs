import { parentPort, workerData } from 'node:worker_threads';
const port=parentPort;
if(!port || process.execArgv.length || Object.keys(process.env).length) throw new Error('isolation');
const {attemptId,plan,fixtureScenario}=workerData;
/** @param {Record<string,unknown>} message */
const send=(message)=>port.postMessage(JSON.stringify({v:1,attemptId,...message}));
const outcomes=plan.methods.map((/** @type {import('../../shared/types.js').DiscoveryMethod} */ method)=>({
  method,attempted:method==='tcp'?plan.tcpBudget:method==='ptr'?plan.dnsBudget:1,
  completed:method==='tcp'?plan.tcpBudget:method==='ptr'?plan.dnsBudget:1,responses:0,durationMs:1,issues:fixtureScenario==='method-issues'&&method==='tcp'?['access_denied']:[],
}));
const progress={addressesCompleted:0,totalAddresses:plan.targets.length,tcpCompleted:0,dnsCompleted:0,datagramsSent:0};
/** @param {string} address */
const row=(address)=>({address,ports:plan.ports.map((/** @type {number} */ port)=>({port,state:port===443?'open':'closed'})),
  dns:{state:plan.methods.includes('ptr')?'no_data':'not_requested',names:[]},mdns:[],nbns:false,ssdp:[],ttlMs:60000});
for(const address of plan.targets) {
  send({type:'batch',result:row(address)});
  progress.addressesCompleted++;progress.tcpCompleted+=plan.ports.length;progress.dnsCompleted+=Number(plan.methods.includes('ptr'));
  send({type:'progress',progress:{...progress}});
  if(fixtureScenario==='hold-after-first') await new Promise((resolve)=>setTimeout(resolve,60000));
  if(fixtureScenario==='late-after-done') {
    send({type:'done',failures:['collector_error'],outcomes});
    send({type:'batch',result:row(plan.targets[1])});
    send({type:'progress',progress:{...progress,addressesCompleted:2,tcpCompleted:plan.ports.length*2}});
    break;
  }
}
if(fixtureScenario==='complete'||fixtureScenario==='method-issues')send({type:'done',failures:fixtureScenario==='method-issues'?['tcp_error']:[],outcomes});
