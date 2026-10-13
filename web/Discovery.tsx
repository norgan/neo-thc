import { useEffect, useRef, useState } from 'react';
import type { DiscoveryInterface, DiscoveryMethod, DiscoveryPlan, DiscoveryDefaults } from '../shared/types.js';
import { formBudget } from '../shared/discovery-form.js';
const methods: { key:DiscoveryMethod; label:string }[] = [
  {key:'tcp',label:'TCP connect port probes'},
  {key:'ptr',label:'Reverse DNS (PTR) through my chosen resolver'},
  {key:'mdns',label:'mDNS service-type multicast (not full service discovery)'},
  {key:'ssdp',label:'SSDP root-device multicast (no URL fetching)'},
  {key:'nbns',label:'Legacy NetBIOS browse-master broadcast (limited coverage)'},
];
async function api<T>(path:string, body?:unknown):Promise<T> {
  const response = await fetch('/api/v1/discovery/' + path, {
    method:body ? 'POST' : 'GET',
    headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'},
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  const data = await response.json() as T & {error?:string};
  if (!response.ok) throw new Error(data.error ?? 'Discovery request failed');
  return data;
}
export function Discovery({disabled,blockedReason,onStarted}:{disabled:boolean;blockedReason:string;onStarted:()=>void}) {
  const [interfaces,setInterfaces] = useState<DiscoveryInterface[]>([]);
  const [defaults,setDefaults] = useState<Record<string,DiscoveryDefaults>>({});
  const [interfaceId,setInterfaceId] = useState('');
  const [cidr,setCidr] = useState('');
  const [selected,setSelected] = useState<DiscoveryMethod[]>([]);
  const [portText,setPortText] = useState('');
  const [resolver,setResolver] = useState('');
  const [linkApproved,setLinkApproved] = useState(false);
  const [confirmed,setConfirmed] = useState(false);
  const [preview,setPreview] = useState<DiscoveryPlan|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [reload,setReload] = useState(0);
  const inFlight=useRef(false);
  const configurationVersion=useRef(0);
  const requestId = useRef(crypto.randomUUID());
  const local = interfaces.find((item) => item.id === interfaceId);
  const link = selected.includes('mdns') || selected.includes('nbns') || selected.includes('ssdp');
  useEffect(() => {
    let mounted = true;
    void api<{interfaces:DiscoveryInterface[];defaults?:Record<string,DiscoveryDefaults>}>('options').then((result) => {
      if (mounted) { setInterfaces(result.interfaces); setDefaults(result.defaults??{}); setError(''); }
    }).catch(() => { if (mounted) setError('Could not read local interfaces. Retry before selecting a scope.'); });
    return () => { mounted = false; };
  },[reload]);
  useEffect(() => { configurationVersion.current++;setPreview(null);setConfirmed(false); },[interfaceId,cidr,selected,portText,resolver,linkApproved,local?.address,local?.netmask,local?.cidr]);
  useEffect(() => {setLinkApproved(false);},[local?.address,local?.netmask,local?.cidr]);
  const budget=formBudget(local,cidr,selected,portText);
  const blockers=[...(disabled?[blockedReason||'Discovery is temporarily unavailable.']:[]),...budget.errors,
    ...(selected.includes('ptr')&&!resolver?['Choose an on-link IPv4 DNS resolver. Detected unsupported resolvers cannot be used automatically.']:[]),
    ...(link&&!linkApproved?['Approve link-wide transmission before previewing these methods.']:[])];
  const changeInterface=(id:string)=>{
    const next=interfaces.find((item)=>item.id===id);
    setInterfaceId(id);setCidr(next?.cidr??'');setResolver(defaults[id]?.resolver??'');
    setLinkApproved(false);setPreview(null);setConfirmed(false);
  };
  const settings = () => ({
    requestId:requestId.current, interfaceId, cidr, methods:selected,
    ports:selected.includes('tcp') ? budget.ports : [],
    ...(selected.includes('ptr') ? {resolver} : {}),
    linkScopeConfirmed:link && linkApproved,
  });
  async function showPreview() {
    if(busy||blockers.length)return;
    setBusy(true);setError('');setPreview(null);setConfirmed(false);
    const version=configurationVersion.current;
    try { const result=await api<{plan:DiscoveryPlan}>('preview',settings());if(version===configurationVersion.current)setPreview(result.plan); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not preview discovery'); }
    finally { setBusy(false); }
  }
  async function start() {
    if (!preview || !confirmed || busy || disabled || inFlight.current) return;
    inFlight.current=true;
    setBusy(true);setError('');
    try {
      await api('jobs',{...settings(),confirmScope:true});
      requestId.current=crypto.randomUUID();setPreview(null);setConfirmed(false);onStarted();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not start discovery'); }
    finally { inFlight.current=false;setBusy(false); }
  }
  return <section className="panel">
    <div className="eyebrow">REAL NETWORK TRAFFIC · OPT IN</div><h2>Scoped IPv4 discovery</h2>
    <p>Nothing runs on startup or when this screen opens. Select a local interface, exact CIDR and methods, review the budget, then explicitly start. Only scan a network you are authorized to test.</p>
    <p className="muted">IPv4 only; up to 256 addresses and 1,024 TCP attempts. One initial job, at most 60 seconds, no retries or periodic scans. Results are address candidates and untrusted claims, not verified device identities or health.</p>
    {error && <div className="error" role="alert">{error} <button onClick={() => setReload((value) => value+1)}>Retry interface list</button></div>}
    <div id="discovery-blockers" aria-live="polite">{busy?<p>Processing this request…</p>:blockers.length>0?<><p>Before preview:</p><ul>{blockers.map((reason)=><li key={reason}>{reason}</li>)}</ul></>:<p>Ready to preview this scope. No packets have been sent.</p>}</div>
    <fieldset disabled={busy || disabled}><legend>Explicit discovery scope</legend>
      <label className="field">Source interface
        <select value={interfaceId} onChange={(event) => changeInterface(event.target.value)}>
          <option value="">Choose an interface</option>
          {interfaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.address} · {item.cidr}</option>)}
        </select>
      </label>
      {!interfaces.length && <p>No eligible local IPv4 interface is currently available.</p>}
      <label className="field">Approved IPv4 CIDR
        <input value={cidr} placeholder="Select an interface first" onChange={(event) => setCidr(event.target.value)} />
      </label>
      {local&&<p className="muted">CIDR prefilled from this interface's actual address/netmask. You can edit it to a smaller approved scope.</p>}
      <p className="muted">Scope must be on the selected interface. Network/broadcast addresses and this collector's source address are excluded from TCP/PTR targets. To exclude other hosts, choose a smaller CIDR; per-address exclusions are not yet supported.</p>
      {methods.map((method) => <label className="check" key={method.key}>
        <input type="checkbox" checked={selected.includes(method.key)} onChange={(event) => setSelected((current) =>
          event.target.checked ? [...current,method.key] : current.filter((key) => key!==method.key))} /> {method.label}
      </label>)}
      {selected.includes('tcp') && <label className="field">TCP ports, comma separated (maximum eight)
        <textarea rows={2} value={portText} placeholder="80,443" onChange={(event) => setPortText(event.target.value)} />
      </label>}
      {selected.includes('tcp')&&<p role="status">{budget.targets} targets × {budget.uniquePorts} unique ports = {budget.attempts} TCP attempts. Maximum 1,024; up to {budget.maxPorts} ports fit this scope.</p>}
      {selected.includes('ptr') && <><label className="field">Explicit on-link IPv4 DNS resolver
        <input value={resolver} placeholder="192.0.2.1" onChange={(event) => setResolver(event.target.value)} />
      </label>
      <p className="muted">DNS source: {defaults[interfaceId]?.source??'No system DNS configuration available'}. The first supported detected resolver is prefilled; manual edits remain until you change interfaces.</p>
      {defaults[interfaceId]?.servers.length?<ul>{defaults[interfaceId].servers.map((server)=><li key={server.address}>{server.address} · {server.reason}
        {server.supported&&<button type="button" onClick={()=>setResolver(server.address)}>Use {server.address}</button>}</li>)}</ul>:<p>No configured IPv4 resolver was found. Enter your known on-link resolver; no address is guessed.</p>}
      <p className="muted">Only PTR queries for selected IPs are sent to this resolver over UDP/TCP 53. It may forward queries upstream according to its own configuration. No OS/public fallback or lookup of returned names is performed.</p></>}
      {link && <div className="notice">
        <p>Link-wide methods require the entire current /24–/30 interface subnet, without overlapping interfaces. Multicast and broadcast reach listeners beyond individual accepted responses.</p>
        <label className="check"><input type="checkbox" checked={linkApproved} onChange={(event) => setLinkApproved(event.target.checked)} />
          I approve link-wide transmission on {local?.cidr ?? 'the selected interface subnet'}, including all hosts on that link.</label>
      </div>}
      <div className="actions"><button aria-describedby="discovery-blockers" disabled={blockers.length>0} onClick={() => void showPreview()}>Preview discovery</button></div>
    </fieldset>
    {preview && <section className="panel">
      <h3>Review this exact scope</h3>
      <dl><dt>Source</dt><dd>{preview.interface.name} · {preview.interface.address}</dd>
        <dt>Approved CIDR</dt><dd>{preview.cidr}</dd><dt>Address candidates</dt><dd>{preview.targets.length}</dd>
        <dt>TCP attempts</dt><dd>{preview.tcpBudget}; at most 16 concurrent, 400 ms each</dd>
        <dt>PTR queries</dt><dd>{preview.dnsBudget}; at most eight concurrent, bounded resolver timeout</dd>
        <dt>Discovery datagrams</dt><dd>{preview.datagramBudget}; one per selected link-wide method, two-second receive windows</dd>
        <dt>Hard stop</dt><dd>60 seconds; cancellation retains partial evidence</dd></dl>
      {preview.methods.includes('mdns') && <p>mDNS: one PTR query to 224.0.0.251:5353, multicast TTL 255. Service-type advertisements only; no follow-up requests.</p>}
      {preview.methods.includes('ssdp') && <p>SSDP: one root-device M-SEARCH to 239.255.255.250:1900, multicast TTL 1. Advertised URLs are ignored; no control requests or follow-ups.</p>}
      {preview.methods.includes('nbns') && <p>NBNS: one local subnet broadcast to UDP 137, TTL 1. Legacy browse-master response only; many modern systems will not answer.</p>}
      <p className="muted">TCP and DNS budgets count attempts, not exact wire packets. Operating-system TCP behavior and DNS TCP fallback can send additional packets. No advertised URL or address becomes a new target.</p>
      <label className="check"><input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={(event) => setConfirmed(event.target.checked)} />
        I confirm this exact scope and these network methods.</label>
      <button className="primary" disabled={!confirmed || busy || disabled} onClick={() => void start()}>Start approved discovery</button>
    </section>}
  </section>;
}
