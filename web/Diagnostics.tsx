import {useEffect,useRef,useState} from 'react';
import type {DiagnosticPlan,DiagnosticReport,Job,InternetCheck} from '../shared/types.js';
import {connectionAddressProblem,diagnosticAddresses,dnsOutcomeLabel} from '../shared/diagnostics.js';
import {MEDIA_HOSTS,INTERNET_TARGET,DOWNLOAD_HOST,latencySummary} from '../shared/internet.js';

async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch('/api/v1/diagnostics/'+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'}});
  const data=await response.json();if(!response.ok)throw new Error(data.error??'Diagnostic request failed');return data as T;
}
type Options={source:string;gateway?:string|null;resolvers:{interface:string;address:string;family:number;supported:boolean}[];
  interfaces:{name:string;address:string;family:string;cidr:string|null}[]};
const when=(value:number)=>new Date(value).toLocaleString();
export function Diagnostics({active,selectedJobId,jobs,blockedReason,onUpdated,onCancel}:{active:boolean;selectedJobId:string;jobs:Job[];blockedReason:string;
  onUpdated:()=>void;onCancel:(job:Job)=>void}){
  const [options,setOptions]=useState<Options|null>(null),[optionError,setOptionError]=useState(''),[reload,setReload]=useState(0);
  const [hostname,setHostname]=useState(''),[resolvers,setResolvers]=useState(''),[systemLookup,setSystemLookup]=useState(false);
  const [dnsPort,setDnsPort]=useState('53'),[gateway,setGateway]=useState(''),[download,setDownload]=useState(false);
  const [selectedId,setSelectedId]=useState(''),[addresses,setAddresses]=useState<string[]>([]),[port,setPort]=useState('443'),[tls,setTls]=useState(true);
  const [preview,setPreview]=useState<{plan:DiagnosticPlan;body:Record<string,unknown>;operations:number;maxDurationMs?:number}|null>(null);
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),requestId=useRef(crypto.randomUUID()),revision=useRef(0);
  const history=jobs.filter((job)=>!!job.spec.diagnostic&&job.synthetic===false);
  const selected=history.find((job)=>job.id===selectedId)??history[0],report=selected?.diagnosticReport;
  useEffect(()=>{
    if(!active||options)return;
    const controller=new AbortController();
    void api<Options>('options').then((result)=>{if(!controller.signal.aborted){setOptions(result);setOptionError('');
      setResolvers((value)=>value||result.resolvers.find((row)=>row.supported)?.address||'');setGateway((value)=>value||result.gateway||'');}})
      .catch(()=>{if(!controller.signal.aborted)setOptionError('Could not read local DNS configuration. Retry, or enter a known resolver.');});
    return()=>controller.abort();
  },[active,options,reload]);
  useEffect(()=>{revision.current++;setPreview(null);setConfirmed(false);requestId.current=crypto.randomUUID();},[hostname,resolvers,dnsPort,systemLookup,gateway,download,addresses,port,tls,selected?.id]);
  useEffect(()=>{setAddresses([]);},[selected?.id]);
  useEffect(()=>{if(selectedJobId)setSelectedId(selectedJobId);},[selectedJobId]);
  async function review(kind:'dns'|'connect'|'internet'){
    if(inFlight.current||blockedReason)return;
    inFlight.current=true;setBusy(true);setError('');setPreview(null);setConfirmed(false);
    const version=revision.current;
    const body=kind==='internet'?{kind,requestId:requestId.current,resolvers:resolvers.split(/[\s,]+/).filter(Boolean),port:Number(dnsPort),gateway:gateway||null,download}:
      kind==='dns'?{kind,requestId:requestId.current,hostname,resolvers:resolvers.split(/[\s,]+/).filter(Boolean),port:Number(dnsPort),systemLookup}:
      {kind,requestId:requestId.current,dnsJobId:selected?.id,addresses,port:Number(port),tls};
    try{const result=await api<{plan:DiagnosticPlan;operations:number;maxDurationMs?:number}>('preview',body);
      if(version===revision.current)setPreview({...result,body});}
    catch(value){setError(value instanceof Error?value.message:'Could not review checks.');}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function start(){
    if(!preview||!confirmed||blockedReason||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{const result=await api<{job:Job}>('jobs',{...preview.body,confirmed:true});
      setSelectedId(result.job.id);requestId.current=crypto.randomUUID();setPreview(null);setConfirmed(false);onUpdated();}
    catch(value){setError(value instanceof Error?value.message:'Could not start checks.');}
    finally{inFlight.current=false;setBusy(false);}
  }
  return <section hidden={!active} className="diagnostics"><div className="section-title"><div><h2>Home tech support diagnosis</h2>
    <p>Investigate slow Internet, streaming, DNS, IPv4/IPv6 paths and TLS.</p></div></div>
    <p>Start with the guided Internet and streaming check, or open the targeted DNS settings below. Each run is a snapshot from this collector; compare saved results near a failure. Checks do not change network or application settings.</p>
    {blockedReason&&<p className="notice" role="status">{blockedReason}</p>}
    {optionError&&<p className="error" role="alert">{optionError} <button onClick={()=>setReload((value)=>value+1)}>Retry DNS configuration</button></p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>Home Internet and streaming</h3>
      <p>Check YouTube and Netflix name resolution using the selected DNS servers and port. Compare three ping samples to your gateway and Cloudflare, probe IPv4 path MTU, and read local interface settings.</p>
      <p className="break"><strong>DNS recipients:</strong> {resolvers||'reading local configuration…'} · port {dnsPort}. Change these in DNS settings below if needed.</p>
      <fieldset disabled={busy||!!blockedReason}><legend>Internet check settings</legend>
        <label className="field">Gateway (optional literal address)<input value={gateway} placeholder="192.0.2.1" onChange={(event)=>setGateway(event.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={download} onChange={(event)=>setDownload(event.target.checked)}/>Include an 8 MiB streaming capacity download</label>
        <p className="muted">The optional HTTPS test downloads at most 8 MiB of body data from Cloudflare, plus protocol overhead, for up to six seconds. It can use your data allowance and briefly compete with other traffic. No upload or video account login.</p>
        <button disabled={!resolvers} onClick={()=>void review('internet')}>Review Internet and streaming checks</button>
      </fieldset>
    </section>
    <details className="panel"><summary>DNS settings and targeted hostname checks</summary><h3>Check a specific hostname</h3>
      <fieldset disabled={busy||!!blockedReason}><legend>DNS checks</legend>
        <label className="field">Hostname<input value={hostname} placeholder="cloud.example" onChange={(event)=>setHostname(event.target.value)}/></label>
        <p className="muted">Use the full hostname. Short names depend on a DNS suffix, which these exact checks do not append.</p>
        <div className="actions"><button onClick={()=>setHostname('www.youtube.com')}>YouTube DNS</button><button onClick={()=>setHostname('www.netflix.com')}>Netflix DNS</button></div>
        <label className="field">DNS servers (up to three literal addresses)<textarea rows={2} value={resolvers} onChange={(event)=>setResolvers(event.target.value)}/></label>
        <label className="field">DNS port<input type="number" min={1} max={65535} value={dnsPort} onChange={(event)=>setDnsPort(event.target.value)}/></label>
        <p className="muted">Each selected server receives A and AAAA queries on this port. Use 53 normally, or the configured unicast port of a fallback such as Unbound. A server may forward the name upstream. No public resolver is substituted automatically.</p>
        {options&&<details><summary>Detected IPv4/IPv6 DNS and local addresses</summary><p>{options.source}</p>
          <ul>{options.resolvers.map((row,index)=><li className="break" key={index}>{row.interface}: {row.address} · IPv{row.family}
            {row.supported?<button onClick={()=>setResolvers(row.address)}>Use this resolver</button>:<span> · Scoped link-local resolution is not supported here; this entry was retained for diagnosis.</span>}</li>)}</ul>
          <ul>{options.interfaces.map((row,index)=><li className="break" key={index}>{row.name}: {row.address} · {row.family}</li>)}</ul></details>}
        <label className="check"><input type="checkbox" checked={systemLookup} onChange={(event)=>setSystemLookup(event.target.checked)}/>Also compare operating-system resolution</label>
        <p className="muted">This optional lookup uses the OS configuration, independently of the DNS port above. It can consult hosts entries, caches and VPN policy. Its result does not reveal the actual resolver or prove what a browser uses.</p>
        <button disabled={!hostname||!resolvers} onClick={()=>void review('dns')}>Review DNS checks</button>
      </fieldset>
    </details>
    {preview&&<section className="panel notice"><h3>Approve these exact checks</h3>
      {preview.plan.kind==='internet'?<><p className="break">{MEDIA_HOSTS.join(' and ')} → {preview.plan.resolvers.join(', ')} · DNS port {preview.plan.port} · A + AAAA</p>
        <p className="break">Three ICMP echo samples to {preview.plan.gateway?preview.plan.gateway+' and ':''}{INTERNET_TARGET}. Up to eleven IPv4 probes to {INTERNET_TARGET} with fragmentation disabled. Read local MTU, DHCP, DNS suffix and gateway configuration.</p>
        <p>{preview.plan.download?'Download at most 8 MiB of response body from https://'+DOWNLOAD_HOST+'/__down over verified TLS. No redirects, cookies, login or upload.':'No capacity download selected.'}</p></>:
      preview.plan.kind==='dns'?<><p className="break"><strong>{preview.plan.hostname}</strong> → {preview.plan.resolvers.join(', ')} · DNS port {preview.plan.port??53} · A + AAAA</p>
        {preview.plan.systemLookup&&<p>Also use this collector’s operating-system name resolution, including its configured DNS/VPN/hosts policy.</p>}</>:
        <p className="break"><strong>{preview.plan.hostname}</strong> → {preview.plan.addresses.join(', ')} · TCP {preview.plan.port}{preview.plan.tls?' and hostname-verified TLS':''}. No HTTP or login is sent.</p>}
      <p>{preview.operations} bounded operations. Maximum {(preview.maxDurationMs??12000)/1000} seconds; partial results are retained. DNS answers do not trigger connections. {preview.plan.kind==='internet'?'The public ping/MTU/download targets are fixed and listed above.':'Connection checks use only the addresses selected above, with no address-family fallback.'}</p>
      <label className="check"><input type="checkbox" checked={confirmed} disabled={busy||!!blockedReason} onChange={(event)=>setConfirmed(event.target.checked)}/>I approve sending this hostname and these exact checks.</label>
      <button className="primary" disabled={!confirmed||busy||!!blockedReason} onClick={()=>void start()}>Start approved checks</button>
    </section>}
    <section className="panel"><h3>Saved diagnoses</h3>
      {history.length>1&&report?.kind==='internet'?<details><summary>Recent Internet and streaming checks</summary><ul>{history.filter((job)=>job.spec.diagnostic?.kind==='internet'&&job.diagnosticReport).slice(0,5).map((job)=>{
        const sample=job.diagnosticReport!.internet?.find((check)=>check.kind==='transfer'),ping=job.diagnosticReport!.internet?.find((check)=>check.kind==='latency'&&check.target===INTERNET_TARGET);
        const average=ping?.kind==='latency'?latencySummary(ping).averageMs:null;
        return <li key={job.id}>{when(job.createdAt)} · Internet RTT {average===null?'unavailable':average.toFixed(1)+' ms'} · capacity {sample?.kind==='transfer'&&sample.mbps!==null?sample.mbps.toFixed(1)+' Mbps':'not measured'} · {job.status.replaceAll('_',' ')}</li>;
      })}</ul><p className="muted">Compare snapshots from the same collector and network. Brief samples do not establish sustained playback quality.</p></details>:history.length>1&&<details><summary>Recent DNS timing for this hostname</summary>
        <ul>{history.filter((job)=>job.spec.diagnostic?.kind==='dns'&&job.spec.diagnostic.hostname===report?.hostname&&job.diagnosticReport).slice(0,5).map((job)=>{
          const rows=job.diagnosticReport!.dns.filter((row)=>row.recordType!=='system');
          return <li key={job.id}>{when(job.createdAt)} · DNS port {job.spec.diagnostic?.kind==='dns'?job.spec.diagnostic.port??53:53} · {rows.length?Math.max(...rows.map((row)=>row.durationMs))+' ms slowest DNS check':'no DNS results'} · {rows.filter((row)=>['timeout','servfail','refused','unavailable'].includes(row.status)).length} query errors · {job.status.replaceAll('_',' ')}</li>;
        })}</ul><p className="muted">These are separate snapshots, not continuous monitoring. Cache warming and different DNS views can change timing and answers.</p></details>}
      {!history.length?<p>No diagnoses yet. Enter the failing hostname and review the DNS checks above.</p>:<>
        <label className="field">Diagnosis history<select value={selected?.id??''} onChange={(event)=>setSelectedId(event.target.value)}>
          {history.map((job)=><option key={job.id} value={job.id}>{job.spec.diagnostic?.hostname} · {job.spec.diagnostic?.kind==='dns'?'DNS':job.spec.diagnostic?.kind==='internet'?'Internet and streaming':'Connection'} · {when(job.createdAt)} · {job.status.replaceAll('_',' ')}</option>)}</select></label>
        {selected&&<p role="status">{selected.status.replaceAll('_',' ')}{!report?.complete?' · Partial results; no final diagnosis yet.':''}
          {['running','queued'].includes(selected.status)&&<button onClick={()=>onCancel(selected)}>Cancel checks</button>}</p>}
        {selected?.errors.map((message,index)=><p className="caution" key={index}>{message}</p>)}
        {report&&<Report report={report}/>}
      </>}
    </section>
    {report?.kind==='dns'&&diagnosticAddresses(report).length>0&&<section className="panel"><h3>2. Compare the returned connection paths</h3>
      <p>Choose at most four exact addresses. Nothing is selected or contacted automatically.</p>
      <fieldset disabled={busy||!!blockedReason}><legend>Approved endpoints</legend>
        {diagnosticAddresses(report).map((address)=>{const problem=connectionAddressProblem(address);return <label className="check break" key={address}>
          <input type="checkbox" disabled={!!problem||(!addresses.includes(address)&&addresses.length>=4)} checked={addresses.includes(address)} onChange={(event)=>setAddresses((current)=>event.target.checked?[...current,address]:current.filter((value)=>value!==address))}/>
          <span>{address} · IPv{address.includes(':')?'6':'4'}{problem?' · '+problem:''}</span></label>;})}
        <label className="field">Service port<input type="number" min={1} max={65535} value={port} onChange={(event)=>setPort(event.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={tls} onChange={(event)=>setTls(event.target.checked)}/>Verify TLS for this hostname</label>
        <p className="muted">TLS sends a handshake with this hostname and verifies the certificate. TCP-only checks do not send application data. No credentials, URL fetching, redirects or retries.</p>
        <button disabled={!addresses.length} onClick={()=>void review('connect')}>Review connection checks</button>
      </fieldset>
    </section>}
  </section>;
}
function Report({report}:{report:DiagnosticReport}){
  return <><p className="muted">{report.vantage} · started {when(report.startedAt)} · updated {when(report.updatedAt)}</p>
    {report.findings.map((finding)=><div className="notice diagnostic-finding" key={finding.code}><h4>{finding.title}</h4><p>{finding.detail}</p><p><strong>Next step:</strong> {finding.nextStep}</p></div>)}
    {report.kind==='internet'&&<div className="notice"><h4>YouTube and Netflix DNS summary</h4>{MEDIA_HOSTS.map((hostname)=>{
      const rows=report.dns.filter((row)=>row.hostname===hostname),a=rows.filter((row)=>row.recordType==='A'),aaaa=rows.filter((row)=>row.recordType==='AAAA');
      return <p className="break" key={hostname}>{hostname} · A {a.filter((row)=>row.status==='answer').length}/{a.length} answered · AAAA {aaaa.filter((row)=>row.status==='answer').length}/{aaaa.length} answered{rows.length?' · '+Math.min(...rows.map((row)=>row.durationMs))+'–'+Math.max(...rows.map((row)=>row.durationMs))+' ms':''}</p>;
    })}</div>}
    {report.internet?.map((check,index)=><InternetResult key={index} check={check}/>)}
    {report.kind==='internet'?<details><summary>Detailed DNS answers, TTLs and timing</summary><AddressEvidence report={report}/></details>:<AddressEvidence report={report}/>}
    <p className="muted">DNS answers and TTL differences can be legitimate. Results describe this collector at this time; they do not prove other devices, browsers or applications behave the same way. Browser secure DNS, video CDN requests and HTTP/3/QUIC are not tested by these TCP/TLS checks.</p>
  </>;
}
function AddressEvidence({report}:{report:DiagnosticReport}){
  return <ul className="diagnostic-results">{report.dns.map((row,index)=><li key={index}><strong>{row.hostname?row.hostname+' · ':''}{row.recordType==='system'?'Operating-system lookup':row.recordType+' via '+row.source+' · DNS port '+(row.port??53)}</strong>
    <p>{dnsOutcomeLabel(row.status)} · {row.durationMs} ms</p><ul>{row.answers.map((answer,index)=><li className="break" key={index}>{answer.address} · IPv{answer.family} · {answer.ttl===null?'TTL unavailable from OS lookup':'TTL '+answer.ttl+' seconds'}</li>)}</ul></li>)}
    {report.connections.map((row,index)=><li className="break" key={index}><strong>IPv{row.family} · {row.address.includes(':')?'['+row.address+']':row.address}:{row.port}</strong><p>TCP: {row.tcp.replaceAll('_',' ')} · TLS: {row.tls.replaceAll('_',' ')} · {row.durationMs} ms</p><p>Local source: {row.sourceAddress??'not established'}</p></li>)}</ul>;
}
function InternetResult({check}:{check:InternetCheck}){
  if(check.kind==='settings')return <div className="notice"><h4>Local interface settings</h4><p>{check.status==='read'?'Detected IPv4 gateway: '+(check.gateway??'not available or ambiguous'):'Settings read unavailable'}</p>
    <ul>{check.interfaces.map((row,index)=><li className="break" key={index}>{row.name} · IPv{row.family} · MTU {row.mtu} · {row.defaultRoute?'configured-gateway interface':'other interface'} · DHCP {row.dhcp===null?'unknown':row.dhcp?'enabled':'disabled'}{row.dnsSuffix?' · DNS suffix '+row.dnsSuffix:''}</li>)}</ul></div>;
  if(check.kind==='latency'){const summary=latencySummary(check);return <div className="notice"><h4 className="break">Ping samples to {check.target}</h4>
    <p>{summary.replies}/{summary.sent} replies · average {summary.averageMs===null?'unavailable':summary.averageMs.toFixed(1)+' ms'} · successive RTT variation {summary.variationMs===null?'unavailable':summary.variationMs.toFixed(1)+' ms'}</p>
    <p>{summary.lossPercent===null?'Some probes were unavailable.':summary.lossPercent.toFixed(0)+'% missing replies in this small ICMP sample.'} This does not measure dropped video frames or media packet loss.</p></div>;}
  if(check.kind==='mtu')return <div className="notice"><h4>IPv4 path MTU to {check.target}</h4><p>{check.status.replaceAll('_',' ')}{check.mtu!==null?' · '+check.mtu+' bytes':''}</p>
    <details><summary>MTU probe evidence</summary><ul>{check.probes.map((probe,index)=><li key={index}>{probe.payload} payload bytes · {probe.status.replaceAll('_',' ')}</li>)}</ul></details></div>;
  return <div className="notice"><h4>Streaming capacity sample</h4><p>{(check.bytes/1048576).toFixed(2)} MiB from Cloudflare in {(check.durationMs/1000).toFixed(2)} seconds · {check.mbps===null?'rate unavailable':check.mbps.toFixed(1)+' Mbps'} · {check.status.replaceAll('_',' ')}</p>
    <p>One short transfer estimates network capacity. It does not establish sustained bandwidth, video CDN performance, resolution, DRM, buffer health or dropped frames.</p>
    <p><a href="https://help.netflix.com/en/node/306" target="_blank" rel="noreferrer">Netflix speed guidance</a> · <a href="https://support.google.com/youtube/answer/78358" target="_blank" rel="noreferrer">YouTube speed guidance</a></p></div>;
}
