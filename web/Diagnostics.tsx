import {useEffect,useRef,useState} from 'react';
import type {DiagnosticPlan,DiagnosticReport,Job} from '../shared/types.js';
import {connectionAddressProblem,diagnosticAddresses} from '../shared/diagnostics.js';

async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch('/api/v1/diagnostics/'+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'}});
  const data=await response.json();if(!response.ok)throw new Error(data.error??'Diagnostic request failed');return data as T;
}
type Options={source:string;resolvers:{interface:string;address:string;family:number;supported:boolean}[];
  interfaces:{name:string;address:string;family:string;cidr:string|null}[]};
const when=(value:number)=>new Date(value).toLocaleString();
export function Diagnostics({active,selectedJobId,jobs,blockedReason,onUpdated,onCancel}:{active:boolean;selectedJobId:string;jobs:Job[];blockedReason:string;
  onUpdated:()=>void;onCancel:(job:Job)=>void}){
  const [options,setOptions]=useState<Options|null>(null),[optionError,setOptionError]=useState(''),[reload,setReload]=useState(0);
  const [hostname,setHostname]=useState(''),[resolvers,setResolvers]=useState(''),[systemLookup,setSystemLookup]=useState(false);
  const [selectedId,setSelectedId]=useState(''),[addresses,setAddresses]=useState<string[]>([]),[port,setPort]=useState('443'),[tls,setTls]=useState(true);
  const [preview,setPreview]=useState<{plan:DiagnosticPlan;body:Record<string,unknown>;operations:number}|null>(null);
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),requestId=useRef(crypto.randomUUID()),revision=useRef(0);
  const history=jobs.filter((job)=>!!job.spec.diagnostic&&job.synthetic===false);
  const selected=history.find((job)=>job.id===selectedId)??history[0],report=selected?.diagnosticReport;
  useEffect(()=>{
    if(!active||options)return;
    const controller=new AbortController();
    void api<Options>('options').then((result)=>{if(!controller.signal.aborted){setOptions(result);setOptionError('');
      setResolvers((value)=>value||result.resolvers.find((row)=>row.supported)?.address||'');}})
      .catch(()=>{if(!controller.signal.aborted)setOptionError('Could not read local DNS configuration. Retry, or enter a known resolver.');});
    return()=>controller.abort();
  },[active,options,reload]);
  useEffect(()=>{revision.current++;setPreview(null);setConfirmed(false);requestId.current=crypto.randomUUID();},[hostname,resolvers,systemLookup,addresses,port,tls,selected?.id]);
  useEffect(()=>{setAddresses([]);},[selected?.id]);
  useEffect(()=>{if(selectedJobId)setSelectedId(selectedJobId);},[selectedJobId]);
  async function review(kind:'dns'|'connect'){
    if(inFlight.current||blockedReason)return;
    inFlight.current=true;setBusy(true);setError('');setPreview(null);setConfirmed(false);
    const version=revision.current;
    const body=kind==='dns'?{kind,requestId:requestId.current,hostname,resolvers:resolvers.split(/[\s,]+/).filter(Boolean),systemLookup}:
      {kind,requestId:requestId.current,dnsJobId:selected?.id,addresses,port:Number(port),tls};
    try{const result=await api<{plan:DiagnosticPlan;operations:number}>('preview',body);
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
  return <section hidden={!active} className="diagnostics"><div className="section-title"><div><h2>DNS and connection diagnosis</h2>
    <p>Find whether a name, IPv4/IPv6 path or TLS certificate is failing.</p></div></div>
    <p>Check one hostname from this Neo collector. Each run is a snapshot; repeat just after a failure or wake event to compare. Checks do not change DNS, IPv6 or application settings.</p>
    {blockedReason&&<p className="notice" role="status">{blockedReason}</p>}
    {optionError&&<p className="error" role="alert">{optionError} <button onClick={()=>setReload((value)=>value+1)}>Retry DNS configuration</button></p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>1. Check the hostname</h3>
      <fieldset disabled={busy||!!blockedReason}><legend>DNS checks</legend>
        <label className="field">Hostname<input value={hostname} placeholder="cloud.example" onChange={(event)=>setHostname(event.target.value)}/></label>
        <label className="field">DNS servers (up to three literal addresses)<textarea rows={2} value={resolvers} onChange={(event)=>setResolvers(event.target.value)}/></label>
        <p className="muted">Each selected server receives an A and an AAAA query over DNS port 53. A server may forward the name upstream. No public resolver is substituted automatically.</p>
        {options&&<details><summary>Detected IPv4/IPv6 DNS and local addresses</summary><p>{options.source}</p>
          <ul>{options.resolvers.map((row,index)=><li className="break" key={index}>{row.interface}: {row.address} · IPv{row.family}
            {row.supported?<button onClick={()=>setResolvers(row.address)}>Use this resolver</button>:<span> · Scoped link-local resolution is not supported here; this entry was retained for diagnosis.</span>}</li>)}</ul>
          <ul>{options.interfaces.map((row,index)=><li className="break" key={index}>{row.name}: {row.address} · {row.family}</li>)}</ul></details>}
        <label className="check"><input type="checkbox" checked={systemLookup} onChange={(event)=>setSystemLookup(event.target.checked)}/>Also compare operating-system resolution</label>
        <p className="muted">This optional lookup can consult hosts entries, caches, VPN policy or other system-configured resolvers. Its result does not reveal the actual resolver or prove what a browser uses.</p>
        <button disabled={!hostname||!resolvers} onClick={()=>void review('dns')}>Review DNS checks</button>
      </fieldset>
    </section>
    {preview&&<section className="panel notice"><h3>Approve these exact checks</h3>
      {preview.plan.kind==='dns'?<><p className="break"><strong>{preview.plan.hostname}</strong> → {preview.plan.resolvers.join(', ')} · A + AAAA</p>
        {preview.plan.systemLookup&&<p>Also use this collector’s operating-system name resolution, including its configured DNS/VPN/hosts policy.</p>}</>:
        <p className="break"><strong>{preview.plan.hostname}</strong> → {preview.plan.addresses.join(', ')} · TCP {preview.plan.port}{preview.plan.tls?' and hostname-verified TLS':''}. No HTTP or login is sent.</p>}
      <p>{preview.operations} bounded operations. Maximum 12 seconds; partial results are retained. DNS checks do not connect to returned addresses. Connection checks use only the addresses selected above, with no address-family fallback.</p>
      <label className="check"><input type="checkbox" checked={confirmed} disabled={busy||!!blockedReason} onChange={(event)=>setConfirmed(event.target.checked)}/>I approve sending this hostname and these exact checks.</label>
      <button className="primary" disabled={!confirmed||busy||!!blockedReason} onClick={()=>void start()}>Start approved checks</button>
    </section>}
    <section className="panel"><h3>Saved diagnoses</h3>
      {history.length>1&&<details><summary>Recent DNS timing for this hostname</summary>
        <ul>{history.filter((job)=>job.spec.diagnostic?.kind==='dns'&&job.spec.diagnostic.hostname===report?.hostname&&job.diagnosticReport).slice(0,5).map((job)=>{
          const rows=job.diagnosticReport!.dns.filter((row)=>row.recordType!=='system');
          return <li key={job.id}>{when(job.createdAt)} · {rows.length?Math.max(...rows.map((row)=>row.durationMs))+' ms slowest DNS check':'no DNS results'} · {rows.filter((row)=>['timeout','servfail','refused','unavailable'].includes(row.status)).length} query errors · {job.status.replaceAll('_',' ')}</li>;
        })}</ul><p className="muted">These are separate snapshots, not continuous monitoring. Cache warming and different DNS views can change timing and answers.</p></details>}
      {!history.length?<p>No diagnoses yet. Enter the failing hostname and review the DNS checks above.</p>:<>
        <label className="field">Diagnosis history<select value={selected?.id??''} onChange={(event)=>setSelectedId(event.target.value)}>
          {history.map((job)=><option key={job.id} value={job.id}>{job.spec.diagnostic?.hostname} · {job.spec.diagnostic?.kind==='dns'?'DNS':'Connection'} · {when(job.createdAt)} · {job.status.replaceAll('_',' ')}</option>)}</select></label>
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
    <ul className="diagnostic-results">{report.dns.map((row,index)=><li key={index}><strong>{row.recordType==='system'?'Operating-system lookup':row.recordType+' via '+row.source}</strong>
      <p>{row.status.replaceAll('_',' ')} · {row.durationMs} ms</p>
      <ul>{row.answers.map((answer,index)=><li className="break" key={index}>{answer.address} · IPv{answer.family} · {answer.ttl===null?'TTL unavailable from OS lookup':'TTL '+answer.ttl+' seconds'}</li>)}</ul></li>)}
      {report.connections.map((row,index)=><li className="break" key={index}><strong>IPv{row.family} · {row.address.includes(':')?'['+row.address+']':row.address}:{row.port}</strong><p>TCP: {row.tcp.replaceAll('_',' ')} · TLS: {row.tls.replaceAll('_',' ')} · {row.durationMs} ms</p><p>Local source: {row.sourceAddress??'not established'}</p></li>)}</ul>
    <p className="muted">DNS answers and TTL differences can be legitimate. Results describe this collector at this time; they do not prove other devices, browsers or applications behave the same way. Browser secure DNS, video CDN requests and HTTP/3/QUIC are not tested by these TCP/TLS checks.</p>
  </>;
}
