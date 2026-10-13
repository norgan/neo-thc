import {portHint} from './ports.js';
import type { Asset, KnownService, NetworkFacts, Observation, SystemView } from './types.js';
const catalogue:Record<string,[string,string,string]> = {
  '_glances._tcp.local':['Glances','System monitoring','Monitoring endpoint'],
  '_ssh._tcp.local':['SSH','Remote access','Remote access service'],
  '_smb._tcp.local':['SMB','File sharing','File sharing service'],
  '_nfs._tcp.local':['NFS','File sharing','File sharing service'],
  '_ipp._tcp.local':['IPP','Printing','Printing service'],
  '_ipps._tcp.local':['IPPS','Printing','Printing service'],
  '_airplay._tcp.local':['AirPlay','Media','Media receiver'],
  '_raop._tcp.local':['AirPlay audio','Media','Audio receiver'],
  '_http._tcp.local':['HTTP','Web','Web service'],
  '_https._tcp.local':['HTTPS','Web','Web service'],
};
const portHints:Record<number,[string,string]>={22:['Remote access candidate','SSH commonly uses this port'],80:['Web service candidate','HTTP commonly uses this port'],
  443:['Web/TLS service candidate','HTTPS commonly uses this port; TLS and HTTP were not verified'],
  445:['File sharing candidate','SMB commonly uses this port'],2049:['File sharing candidate','NFS commonly uses this port'],
  8006:['Virtualization management candidate','Proxmox commonly uses this port; the product is not verified'],
  61208:['System monitoring candidate','Glances commonly uses this port; the product is not verified']};
const safeName=(name:string)=>/^[a-zA-Z0-9._-]{1,253}$/.test(name);
export function networkFacts(observation:Observation):NetworkFacts|null {
  if(observation.synthetic!==false||observation.source!=='discovery-v1')return null;
  if(observation.network){
    const value=observation.network;
    if(typeof value.address!=='string'||!Array.isArray(value.ptrNames)||value.ptrNames.length>4||value.ptrNames.some((name)=>!safeName(name))||
      !Array.isArray(value.ports)||value.ports.length>64||value.ports.some((port)=>!Number.isInteger(port.port)||port.port<1||port.port>65535||!['open','closed','timeout','unreachable','error'].includes(port.state))||
      !Array.isArray(value.mdns)||value.mdns.length>4||value.mdns.some((name)=>typeof name!=='string'||!/^_[a-z0-9_-]+\._(?:tcp|udp)\.local$/.test(name))||
      !Array.isArray(value.ssdp)||value.ssdp.length>1||typeof value.nbns!=='boolean')return null;
    return value;
  }
  // Compatibility with Neo's exact former host-authored evidence format; no raw packet parsing.
  const address=observation.identifiers.find((item)=>item.kind==='ip')?.value;
  if(!address)return null;
  const names=/Unverified PTR claims: ([a-zA-Z0-9._-]+(?:, [a-zA-Z0-9._-]+)*)\.(?= |$)/.exec(observation.note)?.[1].split(', ').filter(safeName).slice(0,4)??[];
  const mdns=observation.note.match(/_[a-z0-9_-]+\._(?:tcp|udp)\.local/g)?.slice(0,4)??[];
  const ports=observation.services.flatMap((service)=>{
    const port=/^TCP (\d{1,5})$/.exec(service.name),state=/^Connect result: (open|closed|timeout|unreachable|error)\./.exec(service.note);
    return port&&state?[{port:Number(port[1]),state:state[1]}]:[];
  });
  return {address,ptrNames:names,ptrState:names.length?'answer':/PTR outcome: (\w+)\./.exec(observation.note)?.[1]??'unknown',
    ports,mdns,ssdp:observation.note.includes('Unauthenticated SSDP root-device claims:')?['root-device advertisement']:[],
    nbns:observation.note.includes('Legacy NetBIOS browse-master response')};
}
const responded=(facts:NetworkFacts)=>facts.ports.some((port)=>port.state==='open'||port.state==='closed')||facts.mdns.length>0||facts.ssdp.length>0||facts.nbns;
export function systemViews(assets:Asset[]):SystemView[] {
  const groups=new Map<string,{asset:Asset;facts:NetworkFacts;observation:Observation}[]>();
  for(const asset of assets) {
    if(!asset.latest)continue;
    const facts=networkFacts(asset.latest);if(!facts)continue;
    const key=asset.latest.vantage+'|'+facts.address;
    const group=groups.get(key)??[];group.push({asset,facts,observation:asset.latest});groups.set(key,group);
  }
  return [...groups.entries()].map(([key,rows])=>{
    rows.sort((a,b)=>b.observation.observedAt-a.observation.observedAt||b.observation.receivedAt-a.observation.receivedAt);
    const current=rows[0],lastResponse=rows.find((row)=>responded(row.facts));
    const named=current.facts.ptrNames.some(safeName)?current:undefined;
    const names=[...new Set(rows.flatMap((row)=>row.facts.ptrNames.filter(safeName)))].slice(0,8);
    const services:KnownService[]=[],seen=new Set<string>();
    // Only the newest address observation supplies current service suggestions; prior runs remain evidence.
    for(const row of [current])for(const advertised of row.facts.mdns) {
      if(seen.has(advertised))continue;seen.add(advertised);
      const known=catalogue[advertised];
      services.push({key:advertised,name:known?.[0]??advertised,category:known?.[1]??'Advertised service',
        confidence:'advertised',evidence:'mDNS service-type advertisement: '+advertised,observedAt:row.observation.observedAt});
    }
    const openPorts=current.facts.ports.filter((port)=>port.state==='open').map((port)=>port.port).sort((a,b)=>a-b);
    for(const port of openPorts)services.push({key:'tcp/'+port,name:'TCP '+port+' accepts connections',category:portHints[port]?.[0]??portHint(port)+' candidate',
      confidence:'port-hint',evidence:portHints[port]?.[1]??portHint(port)+' commonly uses this port; protocol and application are not verified',observedAt:current.observation.observedAt,port});
    const roles:SystemView['roles']=[];
    for(const service of services) {
      const label=service.confidence==='advertised'?catalogue[service.key]?.[2]:service.port?portHints[service.port]?.[0]:undefined;
      if(label&&!roles.some((role)=>role.label===label))roles.push({label,confidence:service.confidence,evidence:service.evidence});
    }
    return {key,address:current.facts.address,vantage:current.observation.vantage,
      displayName:named?.facts.ptrNames.find(safeName)??'Unnamed system',nameBasis:named?'PTR' as const:'address' as const,
      nameObservedAt:named?.observation.observedAt??null,currentAssetId:current.asset.id,assetIds:rows.map((row)=>row.asset.id),attemptCount:rows.length,
      responded:!!lastResponse,respondedLatest:responded(current.facts),lastResponseAt:lastResponse?.observation.observedAt??null,
      lastAttemptAt:current.observation.observedAt,services,roles,openPorts,names,identityChanged:names.length>1};
  }).sort((a,b)=>Number(b.responded)-Number(a.responded)||a.displayName.localeCompare(b.displayName)||a.address.localeCompare(b.address));
}
