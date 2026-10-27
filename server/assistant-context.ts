import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {ASSISTANT_LIMITS,type AssistantContext,type AssistantEvidence,type AssistantFinding,type AssistantJson} from '../shared/assistant.js';
import {benchmarkComparisons,type DnsBenchmarkPlan,type DnsBenchmarkResult} from '../shared/dns-benchmark.js';
import {diagnosticFindings} from '../shared/diagnostics.js';
import {internetFindings,latencySummary} from '../shared/internet.js';
import {systemViews} from '../shared/inventory.js';
import {parsePlayback,playbackSummary,type PlaybackRecord} from '../shared/playback.js';
import type {Asset,ConnectionCheck,DiagnosticReport,DnsCheck,GlancesStats,InternetCheck,Job} from '../shared/types.js';
import {isRealJob,type Store} from './store.js';

const LIMITS={jobs:8,stats:3,playback:2,systems:16,failures:12,dnsRows:32,connections:32} as const;
const publicResolvers=new Map([
  ['1.1.1.1','Cloudflare'],['2606:4700:4700::1111','Cloudflare'],
  ['9.9.9.9','Quad9'],['2620:fe::fe','Quad9'],
  ['94.140.14.14','AdGuard'],['2a10:50c0::ad1:ff','AdGuard'],
]);
const publicNames=new Set(['example.com','cloudflare.com','quad9.net','www.youtube.com','www.netflix.com']);
const terminal=new Set(['completed','completed_with_issues']);
const dnsStatuses=new Set(['answer','no_data','nxdomain','not_found','servfail','refused','timeout','cancelled','unavailable','response_cap']);
const status=(value:unknown)=>typeof value==='string'&&['queued','running','completed','cancelled','timed_out','interrupted','failed','completed_with_issues'].includes(value)?value:'unknown';
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const number=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const count=(value:unknown):number|null=>number(value)!==null&&Number.isSafeInteger(value)?value as number:null;
const rounded=(value:number|null)=>value===null?null:Math.round(value*1000)/1000;
const date=(value:unknown,fallback:number)=>number(value)!==null&&Number(value)<=8.64e15?Number(value):fallback;
const evidenceId=(kind:string,id:string)=>'E'+createHash('sha256').update(kind+'\0'+id).digest('hex').slice(0,16);
const sourceId=(id:string)=>/^[a-zA-Z0-9-]{1,80}$/.test(id)?{sourceId:id}:{};
const canonical=(value:string)=>{const [ip,scope]=value.split('%');try{return (isIP(ip)===6?new URL('http://['+ip+']/').hostname.slice(1,-1):ip)+(scope?'%'+scope:'');}catch{return value;}};
const family=(value:string)=>isIP(value.split('%')[0])||null;
const address=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&family(value)!==null&&(!value.includes('%')||/%\d{1,10}$/.test(value));
const nullableNumber=(value:unknown)=>value===null||number(value)!==null;
const port=(value:unknown)=>count(value)!==null&&Number(value)>=1&&Number(value)<=65535;
const pingStatus=(value:unknown)=>typeof value==='string'&&['reply','timeout','too_big','unreachable','unavailable'].includes(value);

function validDns(value:unknown):value is DnsCheck {
  return record(value)&&value.kind==='dns'&&typeof value.source==='string'&&(value.recordType==='system'||address(value.source))&&
    ['A','AAAA','system'].includes(String(value.recordType))&&dnsStatuses.has(String(value.status))&&number(value.durationMs)!==null&&
    (value.port===undefined||port(value.port))&&(value.hostname===undefined||typeof value.hostname==='string'&&/^[a-zA-Z0-9._-]{1,253}\.?$/.test(value.hostname))&&
    Array.isArray(value.answers)&&value.answers.length<=64&&value.answers.every(answer=>record(answer)&&address(answer.address)&&answer.family===family(answer.address)&&nullableNumber(answer.ttl));
}
function validConnection(value:unknown):value is ConnectionCheck {
  return record(value)&&value.kind==='connect'&&address(value.address)&&value.family===family(value.address)&&port(value.port)&&
    (value.sourceAddress===null||address(value.sourceAddress))&&number(value.durationMs)!==null&&
    ['connected','refused','timeout','unreachable','unavailable'].includes(String(value.tcp))&&['verified','certificate_error','handshake_error','timeout','not_requested','not_reached'].includes(String(value.tls));
}
function validInternet(value:unknown):value is InternetCheck {
  if(!record(value))return false;
  if(value.kind==='latency')return address(value.target)&&number(value.durationMs)!==null&&Array.isArray(value.samples)&&value.samples.length>0&&value.samples.length<=8&&
    value.samples.every(sample=>record(sample)&&pingStatus(sample.status)&&nullableNumber(sample.rttMs));
  if(value.kind==='mtu')return address(value.target)&&number(value.durationMs)!==null&&['at_least_1500','reduced','inconclusive'].includes(String(value.status))&&nullableNumber(value.mtu)&&
    Array.isArray(value.probes)&&value.probes.length<=64&&value.probes.every(probe=>record(probe)&&count(probe.payload)!==null&&pingStatus(probe.status));
  if(value.kind==='transfer')return ['complete','deadline','http_error','tls_error','unavailable','byte_cap'].includes(String(value.status))&&count(value.bytes)!==null&&number(value.durationMs)!==null&&nullableNumber(value.mbps);
  if(value.kind==='settings')return ['read','unavailable'].includes(String(value.status))&&(value.gateway===null||address(value.gateway))&&Array.isArray(value.interfaces)&&value.interfaces.length<=128&&
    value.interfaces.every(net=>record(net)&&typeof net.name==='string'&&net.name.length<=1024&&(net.family===4||net.family===6)&&count(net.mtu)!==null&&typeof net.defaultRoute==='boolean'&&(net.dhcp===null||typeof net.dhcp==='boolean'));
  return false;
}

/** Aliases live inside one reviewed preview. The same endpoint has the same name in every evidence item. */
class Identifiers {
  private addresses=new Map<string,string>();
  private names=new Map<string,string>();
  private labels=new Map<string,string>();
  constructor(private include:boolean){}
  address(value:unknown):string {
    if(typeof value!=='string'||value.length>80||!isIP(value.split('%')[0])||value.includes('%')&&!/%\d{1,10}$/.test(value))return 'Unrecognised address';
    const normalized=canonical(value),known=publicResolvers.get(normalized);
    if(known)return known+' ('+normalized+')';
    if(this.include)return normalized;
    if(!this.addresses.has(normalized))this.addresses.set(normalized,'Endpoint '+(this.addresses.size+1));
    return this.addresses.get(normalized)!;
  }
  hostname(value:unknown):string {
    if(typeof value!=='string'||!/^[a-zA-Z0-9._-]{1,253}\.?$/.test(value))return 'Unrecognised name';
    const normalized=value.toLowerCase().replace(/\.$/,'');
    if(publicNames.has(normalized)||this.include)return normalized;
    if(!this.names.has(normalized))this.names.set(normalized,'Hostname '+(this.names.size+1));
    return this.names.get(normalized)!;
  }
  label(value:unknown,kind:'Interface'|'Filesystem'|'System'):string {
    const key=kind+':'+String(value);
    if(!this.labels.has(key))this.labels.set(key,kind+' '+([...this.labels.keys()].filter(item=>item.startsWith(kind+':')).length+1));
    // Free-form interface names, mounts and system labels stay aliases even with identifier consent.
    return this.labels.get(key)!;
  }
}

function base(kind:AssistantEvidence['kind'],id:string,title:string,observedAt:number,complete:boolean):AssistantEvidence {
  return {id:evidenceId(kind,id),kind,title,observedAt,vantage:kind==='playback'?'Browser that captured playback; may differ from the collector':'Selected collector; may differ from the affected computer',complete,summary:'',facts:{},limitations:[],...sourceId(id)};
}
function finding(item:AssistantEvidence,title:string,detail:string,nextStep:string,severity:AssistantFinding['severity']='attention'):AssistantFinding {
  return {id:evidenceId('finding',item.id+title),severity,title,detail,nextStep,evidenceIds:[item.id]};
}
function validPlan(plan:DnsBenchmarkPlan):boolean {
  return Array.isArray(plan.hostnames)&&plan.hostnames.length>=1&&plan.hostnames.length<=3&&plan.hostnames.every(x=>typeof x==='string'&&/^[a-zA-Z0-9._-]{1,253}$/.test(x))&&
    Array.isArray(plan.resolvers)&&plan.resolvers.length>=1&&plan.resolvers.length<=16&&plan.resolvers.every(x=>typeof x==='string'&&x.length<=80&&family(x)!==null&&(!x.includes('%')||/%\d{1,10}$/.test(x)))&&
    Array.isArray(plan.protocols)&&plan.protocols.length>=1&&plan.protocols.length<=2&&plan.protocols.every(x=>['udp','tcp'].includes(x))&&
    Array.isArray(plan.recordTypes)&&plan.recordTypes.length>=1&&plan.recordTypes.length<=2&&plan.recordTypes.every(x=>['A','AAAA'].includes(x))&&
    [plan.hostnames,plan.resolvers,plan.protocols,plan.recordTypes].every(x=>new Set(x).size===x.length)&&
    count(plan.requests)!==null&&plan.requests>=1&&plan.requests<=50&&count(plan.port)!==null&&plan.port>=1&&plan.port<=65535;
}
function validResult(row:DnsBenchmarkResult,requests:number):boolean {
  if(!['complete','no_responses','unavailable','invalid_output','timed_out'].includes(row.status))return false;
  if(row.totalRequests===null||row.successfulRequests===null)return row.totalRequests===null&&row.successfulRequests===null&&row.status!=='complete';
  if(row.totalRequests!==requests||count(row.successfulRequests)===null||row.successfulRequests>row.totalRequests)return false;
  if(row.successfulRequests>0)return row.status==='complete'&&number(row.avgMs)!==null&&number(row.minMs)!==null&&number(row.maxMs)!==null&&row.minMs!<=row.avgMs!&&row.avgMs!<=row.maxMs!;
  return row.status==='no_responses'&&row.avgMs===null&&row.minMs===null&&row.maxMs===null;
}
function benchmark(job:Job,ids:Identifiers):{item:AssistantEvidence;findings:AssistantFinding[]} {
  const report=job.dnsBenchmarkReport,plan=job.spec.dnsBenchmark!;
  const item=base('dns-benchmark',job.id,'DNS resolver benchmark',date(report?.updatedAt??job.finishedAt,job.createdAt),false);
  item.limitations=[
    'Resolver transport family (IPv4/IPv6), question type (A/AAAA), and UDP/TCP are independent dimensions.',
    'Saved benchmark reports do not record which selected addresses were configured system DNS. System-resolver coverage is unknown.',
    'Repeated-name tests include cache effects. They do not establish cold-cache performance, DNSSEC validation, encrypted DNS, local-name support, filtering equivalence, browser DNS behaviour or overall network optimality.',
    'A failed AAAA address lookup alone does not establish an IPv6 transport fault. Targeted DNS checks distinguish absent records, NXDOMAIN, refusal and timeout.',
  ];
  if(!validPlan(plan)||!report||!Array.isArray(report.results)){
    item.summary=report?'Stored benchmark settings could not be interpreted.':'Benchmark has no saved measurements yet.';
    item.facts={jobStatus:status(job.status),hasSavedReport:!!report};return {item,findings:[]};
  }
  const expected=benchmarkComparisons(plan),key=(row:{hostname:string;resolver:string;protocol:string;recordType:string})=>JSON.stringify([row.hostname,row.resolver,row.protocol,row.recordType]);
  const accepted=new Set(expected.map(key)),groups=new Map<string,DnsBenchmarkResult[]>();let rejected=0;
  for(const row of report.results.slice(0,192)){
    if(!row||!accepted.has(key(row))||row.port!==plan.port||row.family!==family(row.resolver)||!validResult(row,plan.requests)){rejected++;continue;}
    const k=key(row);groups.set(k,[...(groups.get(k)??[]),row]);
  }
  const cells=expected.map(row=>({...row,result:groups.get(key(row))?.length===1?groups.get(key(row))![0]:undefined}));
  const duplicateCells=[...groups.values()].filter(rows=>rows.length>1).length;
  const reportFinished=report.complete&&terminal.has(job.status)&&report.totalComparisons===expected.length&&report.results.length===expected.length&&rejected===0&&duplicateCells===0&&cells.every(row=>!!row.result);
  const aggregate=(rows:typeof cells)=>{
    const present=rows.filter(row=>!!row.result),measured=present.filter(row=>row.result!.totalRequests!==null&&row.result!.successfulRequests!==null);
    const attempts=measured.reduce((sum,row)=>sum+row.result!.totalRequests!,0),successes=measured.reduce((sum,row)=>sum+row.result!.successfulRequests!,0);
    const successWeighted=measured.reduce((sum,row)=>sum+(row.result!.avgMs??0)*row.result!.successfulRequests!,0);
    return {expectedComparisons:rows.length,recordedComparisons:present.length,measuredComparisons:measured.length,attempts,successes,
      successPercent:attempts?rounded(100*successes/attempts):null,successfulMeanMs:successes?rounded(successWeighted/successes):null,
      allSelectedLookupsSucceeded:reportFinished&&rows.length>0&&measured.length===rows.length&&attempts===rows.length*plan.requests&&successes===attempts};
  };
  const summaries=plan.resolvers.map(resolver=>{
    const rows=cells.filter(row=>row.resolver===resolver);
    return {resolver:ids.address(resolver),transportFamily:family(resolver),...aggregate(rows),
      matrix:plan.protocols.flatMap(protocol=>plan.recordTypes.map(recordType=>({protocol,recordType,...aggregate(rows.filter(row=>row.protocol===protocol&&row.recordType===recordType))}))) };
  }).sort((a,b)=>Number(b.allSelectedLookupsSucceeded)-Number(a.allSelectedLookupsSucceeded)||b.measuredComparisons-a.measuredComparisons||(b.successPercent??-1)-(a.successPercent??-1)||(a.successfulMeanMs??Infinity)-(b.successfulMeanMs??Infinity));
  const failed=cells.filter(row=>!row.result||row.result.successfulRequests!==plan.requests),winner=summaries.find(row=>row.allSelectedLookupsSucceeded);
  item.complete=reportFinished&&cells.every(row=>!!row.result);
  item.summary=cells.filter(row=>!!row.result).length+' of '+expected.length+' selected comparisons have interpretable saved results. '+(winner?'Lowest successful mean among fully successful selected tests: '+winner.resolver+' ('+winner.successfulMeanMs+' ms).':'No fully successful preferred resolver is established.');
  item.facts={jobStatus:status(job.status),tool:'dns-bench',toolVersion:/^\d+\.\d+\.\d+$/.test(report.toolVersion)?report.toolVersion:'unrecognised',
    hostnames:plan.hostnames.map(value=>ids.hostname(value)),port:plan.port,protocols:plan.protocols,recordTypes:plan.recordTypes,requestsPerComparison:plan.requests,
    ...aggregate(cells),invalidStoredRows:rejected,duplicateComparisons:duplicateCells,resolvers:summaries,
    failedOrMissingComparisons:failed.length,failedOrMissingSample:failed.slice(0,LIMITS.failures).map(row=>({resolver:ids.address(row.resolver),hostname:ids.hostname(row.hostname),protocol:row.protocol,recordType:row.recordType,status:row.result?.status??'missing',successfulRequests:row.result?.successfulRequests??null})),
    omittedFailureDetails:Math.max(0,failed.length-LIMITS.failures),lowestMeanFullySuccessfulResolver:winner?.resolver??null,systemResolverProvenance:'not-recorded'};
  const findings:AssistantFinding[]=[];
  if(!item.complete)findings.push(finding(item,'DNS benchmark coverage is incomplete','Missing, invalid or interrupted comparisons cannot establish the best resolver.','Finish or repeat the selected matrix before choosing a DNS change.'));
  if(failed.length)findings.push(finding(item,'Some DNS benchmark comparisons did not succeed for every lookup',failed.length+' selected comparisons have failed, unavailable or missing measurements.','Inspect the resolver transport family, protocol and record type. Run targeted DNS checks to distinguish absent answers from path or resolver failures.'));
  if(winner)findings.push(finding(item,'A successful DNS candidate has the lowest measured mean',winner.resolver+' returned successful answers for every selected lookup with a mean of '+winner.successfulMeanMs+' ms. This is a sample-specific comparison.','Repeat on the affected computer during the problem. Check filtering, local names and application DNS behaviour before changing settings.','info'));
  if(!plan.resolvers.some(value=>family(value)===6)||!plan.resolvers.some(value=>family(value)===4)||plan.protocols.length<2||plan.recordTypes.length<2)
    findings.push(finding(item,'The selected DNS matrix omits a comparison dimension','Both resolver families, both transport protocols and both address-record types were not all selected.','Add supported IPv4/IPv6 resolvers and select UDP, TCP, A and AAAA to compare the complete supported matrix.'));
  return {item,findings};
}

function safeDns(rows:DnsCheck[],ids:Identifiers):AssistantJson[] {
  return rows.slice(0,LIMITS.dnsRows).filter(row=>row&&['A','AAAA','system'].includes(row.recordType)&&dnsStatuses.has(row.status)).map(row=>({
    resolver:row.recordType==='system'?'Operating-system resolver':ids.address(row.source),resolverTransportFamily:row.recordType==='system'?null:family(row.source),
    recordType:row.recordType,status:row.status,durationMs:rounded(number(row.durationMs)),port:count(row.port??53),
    ...(row.hostname?{hostname:ids.hostname(row.hostname)}:{}),answers:(Array.isArray(row.answers)?row.answers:[]).slice(0,16).map(answer=>({address:ids.address(answer.address),family:answer.family===4||answer.family===6?answer.family:null,ttlSeconds:number(answer.ttl)})),
  }));
}
function diagnosis(job:Job,ids:Identifiers):{item:AssistantEvidence;findings:AssistantFinding[]} {
  const report=job.diagnosticReport,kind=job.spec.diagnostic!.kind;
  const item=base(kind==='connect'?'connectivity':kind,job.id,kind==='dns'?'Targeted DNS checks':kind==='connect'?'TCP and TLS connection checks':'Home Internet diagnosis',date(report?.updatedAt??job.finishedAt,job.createdAt),!!report?.complete&&terminal.has(job.status));
  item.limitations=['Saved observations describe this collector at their timestamps. They do not establish the affected application’s path or current network health.'];
  if(!report){item.summary='No measurements have been saved for this diagnosis.';item.facts={jobStatus:status(job.status)};return {item,findings:[]};}
  const rawDns=Array.isArray(report.dns)?report.dns:[],rawConnections=Array.isArray(report.connections)?report.connections:[],rawInternet=Array.isArray(report.internet)?report.internet:[];
  const dns=rawDns.filter(validDns),connections=rawConnections.filter(validConnection),internet=rawInternet.filter(validInternet);
  const invalidRows=rawDns.length-dns.length+rawConnections.length-connections.length+rawInternet.length-internet.length;
  item.complete=item.complete&&invalidRows===0&&dns.length+connections.length+internet.length>0;
  if(invalidRows)item.limitations.push(invalidRows+' stored measurement rows could not be validated and were excluded. Inspect or repeat the original diagnosis.');
  item.facts={jobStatus:status(job.status),hostname:ids.hostname(report.hostname),dns:safeDns(dns,ids),omittedDnsRows:Math.max(0,dns.length-LIMITS.dnsRows),
    invalidStoredMeasurements:invalidRows,
    connections:connections.slice(0,LIMITS.connections).map(row=>({address:ids.address(row.address),family:row.family===4||row.family===6?row.family:null,port:count(row.port),tcp:['connected','refused','timeout','unreachable','unavailable'].includes(row.tcp)?row.tcp:'unknown',tls:['verified','certificate_error','handshake_error','timeout','not_requested','not_reached'].includes(row.tls)?row.tls:'unknown',durationMs:rounded(number(row.durationMs))})),
    omittedConnections:Math.max(0,connections.length-LIMITS.connections),internet:internet.slice(0,8).flatMap((row):AssistantJson[]=>{
      if(row.kind==='latency')return [{kind:row.kind,target:ids.address(row.target),...latencySummary(row),samples:row.samples.slice(0,8).map(sample=>({status:['reply','timeout','too_big','unreachable','unavailable'].includes(sample.status)?sample.status:'unknown',rttMs:rounded(number(sample.rttMs))}))}];
      if(row.kind==='mtu')return [{kind:row.kind,target:ids.address(row.target),status:['at_least_1500','reduced','inconclusive'].includes(row.status)?row.status:'unknown',mtu:number(row.mtu)}];
      if(row.kind==='transfer')return [{kind:row.kind,status:['complete','deadline','http_error','tls_error','unavailable','byte_cap'].includes(row.status)?row.status:'unknown',bytes:count(row.bytes),durationMs:number(row.durationMs),mbps:number(row.mbps)}];
      if(row.kind==='settings')return [{kind:row.kind,status:row.status==='read'?'read':'unavailable',gateway:row.gateway?ids.address(row.gateway):null,interfaces:row.interfaces.slice(0,16).map(net=>({interface:ids.label(net.name,'Interface'),family:net.family===4||net.family===6?net.family:null,mtu:number(net.mtu),defaultRoute:net.defaultRoute===true,dhcp:typeof net.dhcp==='boolean'?net.dhcp:null}))}];
      return [];
    })};
  item.summary=dns.length+' DNS results, '+connections.length+' connection results and '+internet.length+' Internet measurements saved'+(item.complete?'.':'; incomplete diagnosis.');
  if(kind==='internet')item.limitations.push('Three ICMP samples can be blocked or deprioritised; missing replies do not prove application packet loss. A short Cloudflare transfer is not sustained bandwidth or video-CDN performance. The path MTU probe is IPv4 only.');
  const findings:AssistantFinding[]=[];
  // Recompute fixed application-authored explanations. Never transmit saved free-form findings or errors.
  const bounded:DiagnosticReport={...report,kind,complete:item.complete,dns:dns.slice(0,LIMITS.dnsRows),connections:connections.slice(0,LIMITS.connections),internet:internet.slice(0,8),findings:[]};
  try{for(const row of (kind==='internet'?internetFindings(bounded):diagnosticFindings(bounded)).slice(0,8))findings.push(finding(item,row.title,row.detail,row.nextStep,row.code==='transport_passed'||row.code==='check_connections'?'info':'attention'));}catch{item.limitations.push('Some stored diagnostic measurements could not be interpreted. Inspect the original report.');}
  return {item,findings};
}

function discovery(job:Job,ids:Identifiers):AssistantEvidence {
  const plan=job.spec.discovery!,item=base('inventory',job.id,'Network discovery coverage',date(job.finishedAt,job.createdAt),terminal.has(job.status));
  item.summary='Scoped IPv4 discovery recorded '+(count(job.completedTargets)??'unknown')+' of '+(count(job.totalTargets)??'unknown')+' address attempts.';
  item.facts={jobStatus:status(job.status),sourceInterface:ids.label('interface '+plan.interface.address,'Interface'),sourceAddress:ids.address(plan.interface.address),selectedAddresses:plan.targets.length,
    methods:plan.methods.filter(value=>['tcp','ptr','mdns','nbns','ssdp'].includes(value)),selectedPorts:plan.ports.slice(0,64),
    outcomes:(job.discoveryOutcomes??[]).slice(0,5).map(row=>({method:['tcp','ptr','mdns','nbns','ssdp'].includes(row.method)?row.method:'unknown',attempted:count(row.attempted),completed:count(row.completed),responses:count(row.responses),issues:row.issues.filter(issue=>['access_denied','source_unavailable','network_unreachable','timeout','refused','response_cap','io_error'].includes(issue))}))};
  item.limitations=['Inventory discovery is IPv4-only. A silent host is not proof of absence or failure. An open port is a service hint, not product identification or application health.'];
  return item;
}
function statsEvidence(stats:GlancesStats,asset:Asset,ids:Identifiers):{item:AssistantEvidence;findings:AssistantFinding[]} {
  const item=base('system-stats',stats.id,'Saved system resource snapshot',stats.sampledAt,stats.status==='complete'),address=asset.latest?.network?.address??asset.latest?.identifiers.find(row=>row.kind==='ip')?.value;
  item.summary='Glances reported '+(number(stats.cpuPercent)===null?'unknown CPU utilisation':rounded(stats.cpuPercent)+'% CPU utilisation')+' in this one snapshot.';
  item.facts={system:address?ids.address(address):ids.label(asset.id,'System'),observedFrom:ids.label(asset.latest?.vantage,'Interface'),status:['complete','partial','failed'].includes(stats.status)?stats.status:'unknown',
    cpuPercent:number(stats.cpuPercent),memory:stats.memory?{percent:number(stats.memory.percent),totalBytes:number(stats.memory.totalBytes),availableBytes:number(stats.memory.availableBytes)}:null,
    filesystems:stats.filesystems?.slice(0,16).map(row=>({filesystem:ids.label(asset.id+':'+row.mount,'Filesystem'),sizeBytes:number(row.sizeBytes),freeBytes:number(row.freeBytes),usedPercent:number(row.percent)}))??null,
    omittedFilesystems:Math.max(0,(stats.filesystems?.length??0)-16),incompleteSections:stats.issues.map(row=>['cpu','memory','filesystems','uptime','system','version'].includes(row.section)?row.section:'other').slice(0,8)};
  item.limitations=['A one-off CPU or memory percentage does not establish sustained contention, process responsibility or root cause. Filesystem labels are minimised.'];
  const findings:AssistantFinding[]=[];
  if(number(stats.cpuPercent)!==null&&stats.cpuPercent!>=90)findings.push(finding(item,'High CPU utilisation was sampled','The saved CPU sample was at least 90%. It may be brief and may concern another system.','Repeat during the symptom and inspect per-process use on the affected system before changing hardware or services.'));
  if(stats.filesystems?.some(row=>number(row.percent)!==null&&row.percent>=90))findings.push(finding(item,'A filesystem was at least 90% used','The stored capacity snapshot shows limited free space on at least one filesystem.','Inspect which files are growing, confirm backup and retention requirements, then free or expand space. Verify free bytes afterwards.','warning'));
  return {item,findings};
}
function playbackEvidence(record:PlaybackRecord):{item:AssistantEvidence;findings:AssistantFinding[]}|null {
  let capture;try{capture=parsePlayback(record.capture);}catch{return null;}
  const summary=playbackSummary(capture),item=base('playback',record.id,'Browser playback capture',capture.capturedAt,capture.stopReason==='finished');
  item.summary=capture.provider+' playback: '+rounded(capture.rebufferMs/1000)+' seconds waiting for data across a '+rounded(capture.durationMs/1000)+'-second capture.';
  item.facts={provider:capture.provider,durationMs:capture.durationMs,stopReason:capture.stopReason,waitingEvents:capture.waitingEvents,stalledEvents:capture.stalledEvents,rebufferMs:capture.rebufferMs,longTaskMs:capture.longTaskMs,
    resolutions:summary.resolutions,totalFrames:summary.totalFrames,droppedFrames:summary.droppedFrames,droppedPercent:rounded(summary.droppedPercent),minBufferSeconds:summary.minBufferSeconds,
    reportedConnectionEstimate:{effectiveType:capture.connection.effectiveType,downlinkMbps:capture.connection.downlinkMbps,rttMs:capture.connection.rttMs,saveData:capture.connection.saveData}};
  item.limitations=['User-imported browser evidence is not independently authenticated. Browser connection estimates are not active speed tests. Playback and collector measurements may come from different devices and times. No page URL, media title, account data or video is included.'];
  return {item,findings:summary.findings.slice(0,5).map(text=>finding(item,'Playback evidence',text,'Compare playback buffer, frame drops, device load and Internet measurements from the affected device during the same event.',capture.rebufferMs>0||summary.droppedPercent!==null&&summary.droppedPercent>=1?'attention':'info'))};
}

/** Builds a reviewable, bounded evidence bundle without starting a probe or reading host configuration. */
export function buildAssistantContext(source:Pick<Store,'jobs'|'assets'|'stats'|'playback'>,options:{includeIdentifiers?:boolean;now?:number;focusJobId?:string}={}):AssistantContext {
  const now=options.now??Date.now(),ids=new Identifiers(options.includeIdentifiers===true);
  const context:AssistantContext={generatedAt:now,includeIdentifiers:options.includeIdentifiers===true,evidence:[],findings:[],missingEvidence:[],omitted:{jobs:0,stats:0,playback:0,assets:0}};
  const assets=source.assets().filter(asset=>asset&&asset.latest?.synthetic===false&&asset.latest.source==='discovery-v1'&&Array.isArray(asset.latest.identifiers)&&Array.isArray(asset.latest.services));
  const knownAssets=new Map(assets.map(asset=>[asset.id,asset]));
  const jobs=source.jobs().filter(job=>job&&job.spec&&Array.isArray(job.spec.scope)&&isRealJob(job)&&job.synthetic!==true).sort((a,b)=>b.createdAt-a.createdAt);
  const stats=source.stats().filter(row=>row&&knownAssets.has(row.assetId)).sort((a,b)=>b.sampledAt-a.sampledAt);
  const rawPlayback=source.playback(),playback=rawPlayback.filter(row=>row&&row.capture).sort((a,b)=>b.capture.capturedAt-a.capture.capturedAt);
  const selected:Job[]=[],add=(job:Job|undefined)=>{if(job&&!selected.some(row=>row.id===job.id)&&selected.length<LIMITS.jobs)selected.push(job);};
  if(options.focusJobId)add(jobs.find(job=>job.id===options.focusJobId));
  for(const kind of ['dns-benchmark','dns','connect','internet','discovery'])add(jobs.find(job=>job.spec.dnsBenchmark?kind==='dns-benchmark':job.spec.diagnostic?job.spec.diagnostic.kind===kind:kind==='discovery'));
  const priorityCount=selected.length;
  for(const job of jobs)add(job);
  const addItem=(item:AssistantEvidence,findings:AssistantFinding[],category:keyof AssistantContext['omitted'],weight=1)=>{
    // Reserve room for missing-evidence notices and honest omission counters.
    context.evidence.push(item);context.findings.push(...findings);
    if(JSON.stringify(context).length>ASSISTANT_LIMITS.contextCharacters-2500){context.evidence.pop();context.findings.splice(context.findings.length-findings.length,findings.length);context.omitted[category]+=weight;return false;}
    return true;
  };
  context.omitted.jobs=jobs.length-selected.length;
  const addJob=(job:Job)=>{
    try{
      if(job.spec.dnsBenchmark){const result=benchmark(job,ids);addItem(result.item,result.findings,'jobs');}
      else if(job.spec.diagnostic){const result=diagnosis(job,ids);addItem(result.item,result.findings,'jobs');}
      else if(job.spec.discovery)addItem(discovery(job,ids),[],'jobs');
    }catch{context.omitted.jobs++;}
  };
  for(const job of selected.slice(0,priorityCount))addJob(job);
  const sampled=new Set<string>(),selectedStats=stats.filter(row=>{if(sampled.has(row.assetId)||sampled.size>=LIMITS.stats)return false;sampled.add(row.assetId);return true;});
  context.omitted.stats=stats.length-selectedStats.length;
  for(const row of selectedStats){try{const result=statsEvidence(row,knownAssets.get(row.assetId)!,ids);addItem(result.item,result.findings,'stats');}catch{context.omitted.stats++;}}
  context.omitted.playback=rawPlayback.length-playback.length+Math.max(0,playback.length-LIMITS.playback);
  for(const record of playback.slice(0,LIMITS.playback)){const result=playbackEvidence(record);if(result)addItem(result.item,result.findings,'playback');else context.omitted.playback++;}
  const systems=systemViews(assets).sort((a,b)=>b.lastAttemptAt-a.lastAttemptAt),visible=systems.slice(0,LIMITS.systems);
  context.omitted.assets=Math.max(0,assets.length-visible.reduce((sum,row)=>sum+row.assetIds.length,0));
  if(systems.length){
    const item=base('inventory','overview','Saved network inventory',systems[0].lastAttemptAt,true);
    delete item.sourceId;
    item.summary=systems.length+' address views across '+assets.length+' source-scoped discovery records; identities remain unverified.';
    item.facts={addressViews:systems.length,sourceScopedRecords:assets.length,respondedAtLeastOnce:systems.filter(row=>row.responded).length,respondedInLatestObservation:systems.filter(row=>row.respondedLatest).length,
      systems:visible.map(row=>({address:ids.address(row.address),observedFrom:ids.label(row.vantage,'Interface'),hostname:row.nameBasis==='PTR'?ids.hostname(row.displayName):null,observedAt:row.lastAttemptAt,respondedLatest:row.respondedLatest,identityChanged:row.identityChanged,
        openPorts:row.openPorts.slice(0,64),advertisedServiceCount:row.services.filter(service=>service.confidence==='advertised').length,roleHints:row.roles.map(role=>role.label).slice(0,8)})),omittedAddressViews:Math.max(0,systems.length-visible.length)};
    item.limitations=['Address views are not permanent device identities. Discovery is scoped and IPv4-only; unscanned devices and IPv6-only devices are outside coverage. Stale or silent observations do not prove failure. Service advertisements and port hints do not verify installed products.'];
    addItem(item,[],'assets',visible.reduce((sum,row)=>sum+row.assetIds.length,0));
  }
  for(const job of selected.slice(priorityCount))addJob(job);
  const kinds=new Set(context.evidence.map(row=>row.kind));
  if(!kinds.has('dns-benchmark'))context.missingEvidence.push('No usable DNS benchmark was included. Resolver timing and reliability cannot be compared.');
  if(!kinds.has('dns')&&!kinds.has('internet'))context.missingEvidence.push('No targeted DNS outcomes were included. An absent record cannot be distinguished from a timeout using benchmark timing alone.');
  if(!kinds.has('connectivity'))context.missingEvidence.push('No direct TCP/TLS connection checks were included. DNS answers do not establish an IPv4 or IPv6 application path.');
  if(!kinds.has('internet'))context.missingEvidence.push('No saved Internet diagnosis was included. Gateway/Internet latency, path MTU and short-transfer capacity are unknown.');
  if(!kinds.has('playback'))context.missingEvidence.push('No playback capture was included. Rebuffering and dropped frames have not been observed.');
  if(!kinds.has('system-stats'))context.missingEvidence.push('No saved system resource snapshot was included. CPU, memory and filesystem pressure are unknown.');
  context.missingEvidence.push('Transient desktop CPU, memory and Wi-Fi reads and current adapter configuration are not part of this saved snapshot. NEO can display those separately; they were not read for this conversation. Saved Internet settings, when included, describe their earlier collection time.');
  if(options.focusJobId&&!selected.some(job=>job.id===options.focusJobId))context.missingEvidence.push('The requested diagnostic report is unavailable in the saved real evidence.');
  if(context.evidence.some(item=>now-item.observedAt>24*60*60*1000))context.missingEvidence.push('Some included evidence is more than 24 hours old. Repeat relevant checks during the current symptom before making a change.');
  context.missingEvidence.push('The affected device, connection type, VPN state, desired filtering and symptom timing may need confirmation. No live probes or setting changes were performed for this explanation.');
  return context;
}
