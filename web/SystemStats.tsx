import {useEffect,useRef,useState} from 'react';
import type {GlancesStats,SystemView} from '../shared/types.js';
const bytes=(value:number)=>{const units=['B','KiB','MiB','GiB','TiB','PiB'];let index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return value.toFixed(index?1:0)+' '+units[index];};
const issues:Record<string,string>={
  authentication_required:'Glances requires authentication. No credentials were sent; credentialed connections are not available yet.',
  unsupported_version:'This endpoint did not report a supported Glances API v4 version.',
  not_found:'This fixed API path or plugin is unavailable at the selected endpoint.',
  tls_validation_failed:'TLS certificate validation failed. No certificate bypass is available.',
  connection_refused:'The selected endpoint refused the connection.',
  timeout:'The endpoint exceeded its request deadline.',
  redirect_blocked:'The endpoint redirected the request. Redirects are not followed.',
  invalid_response:'The endpoint returned an unsupported or malformed response.',
  response_too_large:'The response exceeded the bounded size limit.',
  rate_limited:'The endpoint requested a lower request rate. No retry was attempted.',
  cancelled:'The read was cancelled or reached its overall deadline.',
  network_error:'The endpoint could not be read from the selected local interface.',
  cleanup_failed:'Socket cleanup failed. Restart Neo before further collection.',
  http_error:'The endpoint returned an unsuccessful HTTP response.',
};
async function api<T>(path:string,body:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'},body:JSON.stringify(body),signal});
  const data=await response.json() as T&{error?:string};if(!response.ok)throw new Error(data.error??'Stats request failed');return data;
}
export function StatsSnapshot({snapshot}:{snapshot:GlancesStats}) {
  return <section className="panel">
    <div className="row"><h3>System stats</h3><span>{snapshot.status==='complete'?'Read complete':snapshot.status==='partial'?'Partial snapshot':'Read unavailable'}</span></div>
    <p className="muted">Reported by Glances {snapshot.version??'unknown version'} · fetched {new Date(snapshot.sampledAt).toLocaleString()} · {snapshot.endpoint}. One snapshot, no background refresh. Glances may cache measurements.</p>
    {(snapshot.hostname||snapshot.operatingSystem)&&<p><strong>{snapshot.hostname??'Hostname not reported'}</strong> · {snapshot.operatingSystem??'Operating system not reported'}</p>}
    <div className="metric-grid">
      <div><span>CPU</span><strong>{snapshot.cpuPercent===null?'Unavailable':snapshot.cpuPercent.toFixed(1)+'%'}</strong>{snapshot.cpuPercent!==null&&<progress aria-label="Reported CPU usage" max={100} value={snapshot.cpuPercent}/>}</div>
      <div><span>Memory</span><strong>{snapshot.memory===null?'Unavailable':snapshot.memory.percent.toFixed(1)+'%'}</strong>{snapshot.memory&&<><progress aria-label="Reported memory usage" max={100} value={snapshot.memory.percent}/><small>{bytes(snapshot.memory.availableBytes)} available / {bytes(snapshot.memory.totalBytes)} total</small></>}</div>
      <div><span>Uptime</span><strong>{snapshot.uptime??'Unavailable'}</strong></div>
    </div>
    <h3>Filesystem capacity</h3>
    {snapshot.filesystems===null?<p>Filesystem metrics unavailable.</p>:snapshot.filesystems.length===0?<p>No filesystems reported.</p>:<ul className="filesystem-list">{snapshot.filesystems.map((item,index)=><li key={item.mount+'/'+index}>
      <div className="row"><strong>{item.mount}</strong><span>{item.percent.toFixed(1)}% used</span></div>
      <progress aria-label={'Filesystem usage '+item.mount} value={item.percent} max={100}/>
      <small>{bytes(item.freeBytes)} free / {bytes(item.sizeBytes)} total{item.type?' · '+item.type:''}</small>
    </li>)}</ul>}
    <p className="muted">Mounts are shown individually; overlay/bind mounts may overlap and are not summed.</p>
    {snapshot.issues.map((issue,index)=><p className="caution" key={index}><strong>{issue.section}:</strong> {issues[issue.code]??'This section could not be read.'}</p>)}
  </section>;
}
export function SystemStats({system,snapshots,disabled,onUpdated}:{system:SystemView;snapshots:GlancesStats[];disabled:boolean;onUpdated:()=>void}) {
  const [scheme,setScheme]=useState<'http'|'https'>('http'),[port,setPort]=useState('61208');
  const [preview,setPreview]=useState<{endpoint:string;sourceAddress:string;paths:string[]}|null>(null),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const requestId=useRef(crypto.randomUUID()),inFlight=useRef(false),controller=useRef<AbortController|null>(null);
  useEffect(()=>{setPreview(null);setConfirmed(false);requestId.current=crypto.randomUUID();},[scheme,port,system.currentAssetId]);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const current=snapshots.find((item)=>item.assetId===system.currentAssetId);
  const historical=snapshots.filter((item)=>item!==current);
  const body=()=>({requestId:requestId.current,scheme,port:Number(port)});
  async function review() {
    if(busy||disabled)return;setBusy(true);setError('');
    try {setPreview(await api('/api/v1/assets/'+encodeURIComponent(system.currentAssetId)+'/glances/preview',body()));}
    catch(error){setError(error instanceof Error?error.message:'Could not review endpoint');}
    finally{setBusy(false);}
  }
  async function read(){
    if(!preview||!confirmed||disabled||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');controller.current=new AbortController();
    try {await api('/api/v1/assets/'+encodeURIComponent(system.currentAssetId)+'/glances/read',{...body(),confirmed:true},controller.current.signal);
      requestId.current=crypto.randomUUID();setPreview(null);setConfirmed(false);onUpdated();}
    catch(error){setError(controller.current.signal.aborted?'Stats read cancelled. Any saved sections remain in history.':error instanceof Error?error.message:'Could not read stats');onUpdated();}
    finally{inFlight.current=false;setBusy(false);controller.current=null;}
  }
  async function cancel(){await api('/api/v1/stats/'+requestId.current+'/cancel',{}).catch(()=>{});controller.current?.abort();}
  return <>
    {current&&<StatsSnapshot snapshot={current}/>}
    <section className="panel"><h3>{current?'Read a new snapshot':'Connect system stats'}</h3>
      <p>Read real CPU, memory and filesystem capacity from a Glances REST API v4 endpoint on this selected system.</p>
      {system.services.some((service)=>service.key==='_glances._tcp.local')&&<p>Glances was advertised. That service type can be REST or XML-RPC; its API port and protocol have not been resolved.</p>}
      <p className="muted">61208 is the documented default suggestion, not an observed port. Confirm the actual REST endpoint. No installation, credentials, background polling or configuration changes are performed.</p>
      {disabled&&!busy&&<p className="caution">Stats access is paused while another collection is active or the local API is unavailable.</p>}
      {error&&<p className="error" role="alert">{error}</p>}
      <fieldset disabled={busy||disabled}><legend>Glances endpoint on {system.address}</legend>
        <label className="field">Endpoint scheme<select value={scheme} onChange={(event)=>setScheme(event.target.value as 'http'|'https')}><option value="http">HTTP (unencrypted)</option><option value="https">HTTPS (verified certificate)</option></select></label>
        <label className="field">Glances REST port<input type="number" min={1} max={65535} value={port} onChange={(event)=>setPort(event.target.value)}/></label>
        <button disabled={!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535} onClick={()=>void review()}>Review stats access</button>
      </fieldset>
      {preview&&<section className="notice"><h4>Read-only access to {preview.endpoint}</h4><p>Source: {preview.sourceAddress}. At most six sequential GET requests and 12 seconds. No redirects, authentication attempts or retries.</p>
        <details><summary>Exact API paths</summary><ul>{preview.paths.map((path)=><li key={path}>{path}</li>)}</ul></details>
        {scheme==='http'&&<p>These local-network responses will be unencrypted.</p>}
        <label className="check"><input type="checkbox" checked={confirmed} disabled={busy||disabled} onChange={(event)=>setConfirmed(event.target.checked)}/>I approve this read-only stats endpoint.</label>
        <button className="primary" disabled={!confirmed||busy||disabled} onClick={()=>void read()}>Read system stats</button>
      </section>}
      {busy&&<p role="status">Reading endpoint… {inFlight.current&&<button onClick={()=>void cancel()}>Cancel stats read</button>}</p>}
    </section>
    {historical.length>0&&<details className="panel"><summary>Earlier snapshots ({historical.length})</summary><p>Historical reads from this address view are not proof that the same physical system is still present.</p>{historical.map((snapshot)=><StatsSnapshot key={snapshot.id} snapshot={snapshot}/>)}</details>}
  </>;
}
