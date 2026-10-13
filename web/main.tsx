import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Asset, Job, Observation, Snapshot } from '../shared/types.js';
import { Discovery } from './Discovery.js';
import './style.css';

type Tab='Discovery'|'Inventory'|'System'|'Activity';
const tabs:Tab[]=['Discovery','Inventory','System','Activity'];
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
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try {
        const next=await request<Snapshot>('/api/v1/snapshot',{signal:controller.signal});
        if(!controller.signal.aborted){
          if(next.runtime!=='real-discovery-v2'){setLoadError('The API is an older build. Stop Neo, rebuild, restart the API and reload this page.');return;}
          setSnapshot(next);setLoadError('');
        }
      } catch {if(!controller.signal.aborted)setLoadError('The local API is unavailable. Displayed information may be out of date. Start the API, then retry.');}
      finally {if(!controller.signal.aborted)timer=setTimeout(load,2000);}
    };
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[refresh]);
  const assets=(snapshot?.assets??[]).filter((asset)=>asset.latest?.synthetic===false&&asset.latest.source==='discovery-v1');
  const jobs=(snapshot?.jobs??[]).filter((job)=>job.synthetic!==true&&!!job.spec.discovery);
  const running=jobs.find(activeJob);
  const evidenceId=assets.find((asset)=>asset.id===selected)?.latest?.id;
  useEffect(()=>{
    setDetail(null);setDetailError('');
    if(!selected)return;
    const controller=new AbortController();
    void request<{asset:Asset;observations:Observation[]}>('/api/v1/assets/'+encodeURIComponent(selected),{signal:controller.signal})
      .then((data)=>{if(!controller.signal.aborted&&data.asset.latest?.synthetic===false&&data.asset.latest.source==='discovery-v1')setDetail({
        asset:data.asset,observations:data.observations.filter((item)=>item.synthetic===false&&item.source==='discovery-v1')});})
      .catch(()=>{if(!controller.signal.aborted)setDetailError('Could not load evidence. Retry or select another system.');});
    return()=>controller.abort();
  },[selected,evidenceId,refresh]);
  const currentAsset=assets.find((asset)=>asset.id===selected)??detail?.asset;
  const choose=(asset:Asset)=>{setSelected(asset.id);setTab('System');};
  const blockedReason=!snapshot?(loadError||'Waiting for the local API.'):loadError?'Reconnect to the local API before starting discovery.'
    :snapshot.collectionError?snapshot.collectionError:running?'A discovery job is active. Open Activity to review progress or cancel it.':busy?'Finishing the current action.':'';
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
    {tab==='Inventory'&&<section><div className="section-title"><h2>Your inventory</h2><span className="muted">{assets.length} address candidates</span></div>
      {assets.length===0&&<div className="panel"><h3>No network observations yet</h3><p>Select your interface, subnet and methods in Discovery, review the scope, then start one scan.</p><button onClick={()=>setTab('Discovery')}>Set up discovery</button></div>}
      <div className="asset-grid">{assets.map((asset)=><article className="panel" key={asset.id}>
        <div className="eyebrow">{asset.kind}</div><h3>{asset.label}</h3>
        <div className="badges"><Badge value={asset.health}/><Badge value={asset.freshness}/></div>
        <p>{asset.latest?.identifiers.find((item)=>item.kind==='ip')?.value??'No address evidence'}</p>
        <p className="muted">Network address candidate · {asset.latest?.source}</p>
        {asset.identityWarnings.length>0&&<p className="caution">Address reuse or identity ambiguity. Evidence is kept separate.</p>}
        <button onClick={()=>choose(asset)}>Inspect system</button>
      </article>)}</div></section>}
    {tab==='System'&&<section><div className="section-title"><h2>{currentAsset?.label??'System evidence'}</h2><button onClick={()=>setTab('Inventory')}>Back to inventory</button></div>
      {!selected&&<div className="panel">Choose an address candidate from Inventory to view its evidence.</div>}
      {detailError&&<div className="error" role="alert">{detailError} <button onClick={()=>setRefresh((value)=>value+1)}>Retry</button></div>}
      {selected&&!detail&&!detailError&&<p role="status">Loading evidence…</p>}
      {detail&&currentAsset&&<div className="columns"><section className="panel"><h3>Identity and current confidence</h3>
        <div className="badges"><Badge value={currentAsset.health}/><Badge value={currentAsset.freshness}/></div>
        <dl><dt>Internal ID</dt><dd className="break">{detail.asset.id}</dd><dt>Identity basis</dt><dd>Job-scoped address candidate</dd></dl>
        <p className="muted">IP addresses are not permanent device identities. Separate jobs remain separate until identity can be verified.</p>
        {currentAsset.identityWarnings.map((warning)=><p className="caution" key={warning}>{warning}</p>)}
        {currentAsset.latest&&<Evidence observation={currentAsset.latest}/>}
      </section><section className="panel"><h3>Observation history</h3><p className="muted">Latest 100 network observations; earlier evidence remains stored.</p>
        {detail.observations.map((observation)=><details key={observation.id}><summary>{time(observation.observedAt)} · {observation.status}</summary><Evidence observation={observation}/></details>)}
      </section></div>}
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
