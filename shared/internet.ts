import type {DiagnosticPlan,DiagnosticReport,DiagnosticFinding,InternetCheck} from './types.js';
import {diagnosticFindings} from './diagnostics.js';

import {MEDIA_HOSTS,INTERNET_TARGET} from './internet-policy.mjs';
export {MEDIA_HOSTS,INTERNET_TARGET,DOWNLOAD_HOST,DOWNLOAD_BYTES,DOWNLOAD_DEADLINE_MS,INTERNET_DURATION_MS} from './internet-policy.mjs';
export type InternetPlan=Extract<DiagnosticPlan,{kind:'internet'}>;
export function internetOperations(plan:InternetPlan){return 1+plan.resolvers.length*MEDIA_HOSTS.length*2+(plan.gateway?1:0)+1+1+(plan.download?1:0);}
export function latencySummary(check:Extract<InternetCheck,{kind:'latency'}>){
  const replies=check.samples.flatMap((row)=>row.status==='reply'&&row.rttMs!==null?[row.rttMs]:[]);
  const available=check.samples.filter((row)=>row.status!=='unavailable').length;
  return {replies:replies.length,sent:check.samples.length,lossPercent:available===check.samples.length?(check.samples.length-replies.length)*100/check.samples.length:null,
    averageMs:replies.length?replies.reduce((sum,value)=>sum+value,0)/replies.length:null,
    variationMs:replies.length>1?replies.slice(1).reduce((sum,value,index)=>sum+Math.abs(value-replies[index]),0)/(replies.length-1):null};
}
export function internetFindings(report:DiagnosticReport):DiagnosticFinding[]{
  if(!report.complete)return [];
  const findings:DiagnosticFinding[]=[];
  for(const hostname of MEDIA_HOSTS){
    const rows=report.dns.filter((row)=>row.hostname===hostname);
    for(const finding of diagnosticFindings({...report,kind:'dns',hostname,dns:rows,internet:undefined}))
      if(finding.code!=='check_connections')findings.push({...finding,code:hostname+':'+finding.code,title:hostname+': '+finding.title});
  }
  for(const check of report.internet??[]){
    if(check.kind==='latency'){
      const summary=latencySummary(check),isGateway=check.target!==INTERNET_TARGET;
      if(summary.replies!==summary.sent||summary.averageMs!==null&&summary.averageMs>=100||summary.variationMs!==null&&summary.variationMs>=30)
        findings.push({code:'latency:'+check.target,title:(isGateway?'Gateway':'Internet')+' latency needs attention',
          detail:'These three ICMP samples show delay, missing replies or unavailable measurements. ICMP can be blocked or deprioritized; this is not proof of video packet loss.',
          nextStep:isGateway?'Compare Wi-Fi with Ethernet and check signal, interference and local load. Repeat from the device that stalls.':'Compare with the gateway result and repeat during a stall. A good gateway result with poor Internet replies narrows the next check to the upstream path.'});
    }else if(check.kind==='mtu')findings.push({code:'mtu',title:check.status==='at_least_1500'?'The tested IPv4 path carried a 1500-byte packet':check.status==='reduced'?'The tested IPv4 path has a smaller MTU':'Path MTU was not established',
      detail:check.status==='at_least_1500'?'A 1472-byte ICMP payload plus 28 bytes of IPv4/ICMP headers received a reply with fragmentation disabled. This checks one path, not IPv6 or every video CDN.':check.status==='reduced'?'Replies and explicit too-big responses bounded this path to '+check.mtu+' bytes. A smaller MTU can be normal for PPPoE, tunnels or VPNs.':'Missing ICMP replies or an unavailable probe do not establish an MTU fault. No MTU change is justified by this result alone.',
      nextStep:check.status==='reduced'?'Compare the measured path with interface, WAN and VPN MTUs. Check MSS clamping and required packet-too-big signalling before changing anything.':'Use the saved interface settings and retest the affected path during a stall. Do not disable IPv6 or reduce MTU based only on a timeout.'});
    else if(check.kind==='transfer')findings.push({code:'stream_capacity',title:check.mbps===null?'Streaming capacity was not established':'Measured download capacity: '+check.mbps.toFixed(1)+' Mbps',
      detail:check.mbps===null?'The bounded Cloudflare transfer was unavailable, incomplete or too short for a useful rate.':
        'This short Cloudflare sample '+(check.mbps>=20?'exceeded':check.mbps>=15?'exceeded Netflix’s 15 Mbps 4K guidance but was below':'was below')+' the 20 Mbps YouTube 4K guideline. Netflix also recommends 5 Mbps for 1080p. This is capacity at this collector, not observed playback quality or a test of the video CDN.',
      nextStep:'Compare at the TV/device during a stall. Check YouTube “Stats for nerds” for buffer health and dropped frames, or the Netflix app’s network check; also inspect device load and Wi-Fi.'});
    else if(check.kind==='settings'){
      if(check.status==='unavailable')findings.push({code:'settings_unavailable',title:'Local MTU/settings could not be read',detail:'The current platform did not provide the bounded interface read.',nextStep:'Check the active adapter, default route, DNS servers, interface MTU and VPN manually before changing settings.'});
      else if(check.interfaces.some((row)=>row.defaultRoute&&(row.mtu>1500||row.family===6&&row.mtu<1280)))findings.push({code:'interface_mtu',title:'Review the interface MTU',detail:'An interface with a configured gateway has a jumbo MTU or an IPv6 MTU below 1280. Jumbo frames can be intentional; this setting alone does not identify a fault.',nextStep:'Compare the active adapter with the WAN/VPN MTU and the path probe. Check the affected device before changing any MTU.'});
    }
  }
  return findings;
}
