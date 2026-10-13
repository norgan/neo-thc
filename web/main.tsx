import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Asset, Job, Observation, Snapshot, SystemView, GlancesStats } from '../shared/types.js';
import { systemViews } from '../shared/inventory.js';
import { SystemStats } from './SystemStats.js';
import { Discovery } from './Discovery.js';
import './style.css';

type Tab='Discovery'|'Systems'|'System'|'Activity';
const tabs:Tab[]=['Discovery','Systems','System','Activity'];
const activeJob=(job:Job)=>job.status==='queued'||job.status==='running';
const issueText:Record<string,string>={
  access_denied:'The operating system denied this method. Review local security/firewall policy; Neo did not change it.',
  source_unavailable:'The chosen local source could not bind. Check that the interface/address is still present.',
  network_unreachable:'No route was available from the selected source.',
  timeout:'The selected resolver or method did not answer before its deadline.',
  refused:'The selected resolver refused the request.',
  response_cap:'The receive budget was reached; this method has incomplete coverage.',
  io_error:'A bounded socket or resolver operation failed; no raw diagnostic payload was retained.',
};
const time=(timestamp:number)=>new Date(timestamp).toLocaleString();
async function request<T>(url:string,options:RequestInit={}):Promise<T> {
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui',...options.headers}});
  const data=await response.json() as T&{error?:string};
  if(!response.ok)throw new Error(data.error??'Request failed');
  return data;
}
function Badge({value}:{value:string}) {return <span className={'badge '+value}>{value.replaceAll('_',' ')}</span>;}
function Evidence({ observation }: { observation: Observation }) {
  return <div className="evidence">
    <div className="row"><strong>Observed result</strong><Badge value={observation.status} /></div>
    <p><strong>Network evidence</strong></p><p>{observation.note}</p>
    <dl>
      <dt>Source</dt><dd>{observation.source}</dd>
      <dt>Vantage</dt><dd>{observation.vantage}</dd>
      <dt>Observed</dt><dd>{time(observation.observedAt)}</dd>
      <dt>Received</dt><dd>{time(observation.receivedAt)}</dd>
      <dt>Fresh for</dt><dd>{observation.ttlMs / 1000} seconds from observation</dd>
    </dl>
    <ul>{observation.identifiers.map((identifier) =>
      <li key={identifier.kind + identifier.value}>{identifier.kind}: {identifier.value}</li>)}</ul>
    {observation.services.length > 0 && <ul className="services">{observation.services.map((service) =>
      <li key={service.name}><div className="row"><strong>{service.name}</strong><Badge value={service.status} /></div>
        <p>{service.note}</p></li>)}</ul>}
  </div>;
}


function App() {
  const [tab,setTab]=useState<Tab>('Discovery');
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [loadError,setLoadError]=useState('');
  const [actionError,setActionError]=useState('');
  const [busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<{asset:Asset;observations:Observation[]}|null>(null);
  const [detailError,setDetailError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [showAttempts,setShowAttempts]=useState(false),[search,setSearch]=useState('');
  const initialView=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try {
        const next=await request<Snapshot>('/api/v1/snapshot',{signal:controller.signal});
        if(!controller.signal.aborted){
          if(next.runtime!=='semantic-inventory-v3'){setLoadError('The API is an older build. Stop Neo, rebuild, restart the API and reload this page.');return;}
          setSnapshot(next);setLoadError('');
          if(!initialView.current){initialView.current=true;if(systemViews(next.assets).some((view)=>view.responded))setTab('Systems');}
        }
      } catch {if(!controller.signal.aborted)setLoadError('The local API is unavailable. Displayed information may be out of date. Start the API, then retry.');}
      finally {if(!controller.signal.aborted)timer=setTimeout(load,2000);}
    };
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[refresh]);
  const assets=(snapshot?.assets??[]).filter((asset)=>asset.latest?.synthetic===false&&asset.latest.source==='discovery-v1');
  const systems=snapshot?.systems??systemViews(assets);
  const selectedSystem=systems.find((system)=>system.key===selected);
  const selectedAssetId=selectedSystem?.currentAssetId;
  const visibleSystems=systems.filter((system)=>(showAttempts||system.responded)&&(!search||[system.displayName,system.address,...system.services.map((service)=>service.name),...system.roles.map((role)=>role.label)].join(' ').toLowerCase().includes(search.toLowerCase())));
  const jobs=(snapshot?.jobs??[]).filter((job)=>job.synthetic!==true&&!!job.spec.discovery);
  const running=jobs.find(activeJob);
  const evidenceId=assets.find((asset)=>asset.id===selectedAssetId)?.latest?.id;
  useEffect(()=>{
    setDetail(null);setDetailError('');
    if(!selectedAssetId)return;
    const controller=new AbortController();
    void request<{asset:Asset;observations:Observation[]}>('/api/v1/assets/'+encodeURIComponent(selectedAssetId),{signal:controller.signal})
      .then((data)=>{if(!controller.signal.aborted&&data.asset.latest?.synthetic===false&&data.asset.latest.source==='discovery-v1')setDetail({
        asset:data.asset,observations:data.observations.filter((item)=>item.synthetic===false&&item.source==='discovery-v1')});})
      .catch(()=>{if(!controller.signal.aborted)setDetailError('Could not load evidence. Retry or select another system.');});
    return()=>controller.abort();
  },[selectedAssetId,evidenceId,refresh]);
  const currentAsset=assets.find((asset)=>asset.id===selectedAssetId)??detail?.asset;
  const choose=(system:SystemView)=>{setSelected(system.key);setTab('System');};
  const blockedReason=!snapshot?(loadError||'Waiting for the local API.'):loadError?'Reconnect to the local API before starting discovery.'
    :snapshot.collectionError?snapshot.collectionError:snapshot.statsActive?'A system stats read is active. Finish or cancel it before discovery.':running?'A discovery job is active. Open Activity to review progress or cancel it.':busy?'Finishing the current action.':'';
  async function cancel(job:Job) {
    if(busy)return;setBusy(true);setActionError('');
    try {await request('/api/v1/jobs/'+encodeURIComponent(job.id)+'/cancel',{method:'POST',body:'{}'});setRefresh((value)=>value+1);}
    catch(error){setActionError(error instanceof Error?error.message:'Could not cancel discovery');}
    finally{setBusy(false);}
  }
  return <div className="shell">
    <header className="masthead"><div><div className="eyebrow">THE HOMELAB COMPANION</div><h1>neo<span>THC</span></h1><p>Network Environment Overview</p></div>
      <div className="local-label"><span className="dot"/> Local network discovery<br/><strong>{snapshot?.runtime??'Connecting'}</strong></div></header>
    <div className="notice">Choose your local interface and review the exact scope before starting. Nothing scans automatically. Network responses and advertisements do not establish device identity or service health.</div>
    <nav aria-label="Main navigation">{tabs.map((item)=><button key={item} className={tab===item?'selected':''} aria-current={tab===item?'page':undefined} onClick={()=>setTab(item)}>{item}</button>)}</nav>
    <main><div aria-live="polite">
      {loadError&&<div className="error">{loadError} <button onClick={()=>setRefresh((value)=>value+1)}>Retry</button></div>}
      {actionError&&<div className="error">{actionError}</div>}
      {snapshot?.collectionError&&<div className="error">{snapshot.collectionError}</div>}
    </div>
    {tab==='Discovery'&&<>
      {running&&<p role="status">A discovery job is active. <button onClick={()=>setTab('Activity')}>View activity</button></p>}
      <Discovery disabled={!!blockedReason} blockedReason={blockedReason} onStarted={()=>{setRefresh((value)=>value+1);setTab('Activity');}}/>
    </>}
    {tab==='Systems'&&<section><div className="section-title"><div><h2>Your systems</h2><p>{systems.filter((system)=>system.responded).length} address views with observed responses</p></div><button onClick={()=>setTab('Discovery')}>Discover systems</button></div>
      <label className="field">Find a name, service or role<input value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Glances, file sharing, web…"/></label>
      <label className="check"><input type="checkbox" checked={showAttempts} onChange={(event)=>setShowAttempts(event.target.checked)}/>Show all address attempts, including unanswered ones ({systems.length})</label>
      {!systems.length&&<div className="panel"><h3>No network observations yet</h3><p>Discover your network to find observed hostnames, services and likely roles.</p><button onClick={()=>setTab('Discovery')}>Set up discovery</button></div>}
      {systems.length>0&&!visibleSystems.length&&<p>No matching responders. Unanswered attempts remain available using the checkbox above.</p>}
      <div className="semantic-grid">{visibleSystems.map((system)=>{
        const stats=snapshot?.stats?.find((item)=>item.assetId===system.currentAssetId);
        const name=system.nameBasis==='PTR'?system.displayName:stats?.hostname??system.displayName;
        return <article className="panel" key={system.key}>
          <div className="eyebrow">{system.roles[0]?.label??'Observed network endpoint'}</div><h3>{name}</h3>
          <p className="system-subtitle">{system.nameBasis==='PTR'?'Name observed through reverse DNS':stats?.hostname?'Hostname reported by Glances':'No hostname reported'} · {system.address}</p>
          <ul className="service-list">{system.services.filter((service)=>service.confidence==='advertised').map((service)=><li key={service.key}>{service.name} · advertised</li>)}</ul>
          {system.roles.filter((role)=>role.confidence==='port-hint').slice(0,2).map((role)=><p className="muted" key={role.label}>Possible role: {role.label}</p>)}
          <p>{system.openPorts.length?'Accepting TCP connections: '+system.openPorts.join(', '):'No accepting TCP ports observed in the latest scan.'}</p>
          <p className="muted">{system.respondedLatest?'Responded in the latest scan':system.responded?'No response in latest scan; earlier responses are retained':'Attempt only; no direct response observed'}{system.lastResponseAt?' · '+time(system.lastResponseAt):''}</p>
          {stats&&(stats.cpuPercent!==null||stats.memory)?<p>Glances snapshot: {stats.cpuPercent!==null?'CPU '+stats.cpuPercent.toFixed(1)+'%':''}{stats.memory?' · RAM '+stats.memory.percent.toFixed(1)+'%':''}</p>:<p className="muted">System metrics not connected.</p>}
          {system.attemptCount>1&&<p className="muted">Latest address view · {system.attemptCount} scan records retained separately</p>}
          <button onClick={()=>choose(system)}>Inspect system</button>
        </article>;
      })}</div></section>}
    {tab==='System'&&<section><div className="section-title"><div><h2>{selectedSystem?.displayName??'System details'}</h2>
      {selectedSystem&&<p className="system-subtitle">{selectedSystem.address} · {selectedSystem.nameBasis==='PTR'?'Observed reverse-DNS name':'Hostname not reported'}</p>}</div><button onClick={()=>setTab('Systems')}>Back to systems</button></div>
      {!selected&&<div className="panel">Choose a system to see its services, roles and available metrics.</div>}
      {detailError&&<div className="error" role="alert">{detailError} <button onClick={()=>setRefresh((value)=>value+1)}>Retry</button></div>}
      {selected&&!detail&&!detailError&&<p role="status">Loading system details…</p>}
      {selectedSystem&&<section className="panel"><h3>Services and likely roles</h3>
        {selectedSystem.services.length?<ul>{selectedSystem.services.map((service)=><li key={service.key}><strong>{service.name}</strong> · {service.category}<p className="muted">{service.confidence==='advertised'?'Advertised, not protocol-verified':'Port-based hint, not product verification'} · {service.evidence} · observed {time(service.observedAt)}</p></li>)}</ul>:<p>No service advertisements or accepting ports were observed in the latest scan.</p>}
        {selectedSystem.roles.length>0&&<p>Suggested roles: {selectedSystem.roles.map((role)=>role.label).join(', ')}.</p>}
        {selectedSystem.openPorts.includes(8006)&&<p className="muted">TCP 8006 suggests a possible Proxmox management endpoint. It does not identify the product. A credentialed Proxmox integration is not connected.</p>}
        {selectedSystem.identityChanged&&<p className="caution">Multiple names have been observed at this address. Prior runs remain separate; this address view is not a permanent device identity.</p>}
      </section>}
      {selectedSystem&&<SystemStats key={selectedSystem.currentAssetId} system={selectedSystem} snapshots={(snapshot?.stats??[]).filter((item)=>selectedSystem.assetIds.includes(item.assetId))}
        disabled={!!running||!!snapshot?.statsActive||!!snapshot?.collectionError} onUpdated={()=>setRefresh((value)=>value+1)}/>}
      {detail&&currentAsset&&<details className="panel"><summary>Technical evidence and scan history</summary>
        <p>Current evidence: <Badge value={currentAsset.freshness}/> · observed {currentAsset.latest?time(currentAsset.latest.observedAt):'unknown'}</p>
        <p className="muted">Address views consolidate presentation only. Every job-scoped asset and observation is kept separately; names and advertisements can be stale or describe proxies.</p>
        <dl><dt>Current internal ID</dt><dd className="break">{currentAsset.id}</dd></dl>
        {currentAsset.identityWarnings.map((warning)=><p className="caution" key={warning}>{warning}</p>)}
        {currentAsset.latest&&<Evidence observation={currentAsset.latest}/>}
        <h3>Scan history</h3>{detail.observations.map((observation)=><details key={observation.id}><summary>{time(observation.observedAt)} · {observation.status}</summary><Evidence observation={observation}/></details>)}
      </details>}
    </section>}
    {tab==='Activity'&&<section><div className="section-title"><h2>Collection activity</h2><button onClick={()=>setTab('Discovery')}>New discovery</button></div>
      {!jobs.length&&<div className="panel">No discovery jobs yet. Choose and confirm a scope to begin.</div>}
      <div className="job-list">{jobs.map((job)=><article className="panel" key={job.id}>
        <div className="row"><h3>Approved IPv4 discovery</h3><Badge value={job.status}/></div>
        <p className="muted">{time(job.createdAt)} · {job.spec.discovery!.cidr} · source {job.spec.discovery!.interface.address}</p>
        <progress aria-label="Collection progress" value={job.discoveryProgress?.addressesCompleted??0} max={job.spec.discovery!.targets.length}/>
        <p>{job.discoveryProgress?.addressesCompleted??0} / {job.spec.discovery!.targets.length} address attempts · TCP {job.discoveryProgress?.tcpCompleted??0}/{job.spec.discovery!.tcpBudget} · PTR {job.discoveryProgress?.dnsCompleted??0}/{job.spec.discovery!.dnsBudget}</p>
        <p>{job.observationsAdded} observations saved. Address candidates are not a confirmed device count.</p>
        {job.status==='completed_with_issues'&&<p className="caution">Collection completed with method issues. Saved evidence is available; coverage is partial.</p>}
        {job.discoveryOutcomes&&<ul>{job.discoveryOutcomes.map((outcome)=><li key={outcome.method}><strong>{outcome.method.toUpperCase()}</strong>: {outcome.completed}/{outcome.attempted} operations finished, {outcome.responses} responses, {outcome.durationMs} ms.
          {outcome.issues.length?outcome.issues.map((issue)=><p className="caution" key={issue}>{issueText[issue]}</p>):<span> No method errors reported; silence does not prove absence.</span>}</li>)}</ul>}
        {job.status==='failed'&&!job.discoveryOutcomes&&<p className="caution">This older run did not retain per-method diagnostics. Its saved observations remain available; the exact failed method cannot be recovered.</p>}
        {job.errors.map((error,index)=><p className="caution" key={index}>{error}</p>)}
        {activeJob(job)&&<button disabled={busy} onClick={()=>void cancel(job)}>Cancel collection</button>}
        {['cancelled','timed_out','interrupted'].includes(job.status)&&<p>Partial evidence is retained. Start a new job when ready.</p>}
      </article>)}</div>
    </section>}
    </main><footer>Neo · Network Environment Overview <span>THC · The Homelab Companion</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
