import {useEffect,useRef,useState} from 'react';
import type {Job} from '../shared/types.js';
import {canonicalAddress} from '../shared/diagnostics.js';
import {DNS_BENCHMARK_LIMITS,benchmarkComparisons,type DnsBenchmarkCapability,type DnsBenchmarkPlan,type DnsBenchmarkReport,type DnsBenchmarkResult} from '../shared/dns-benchmark.js';

type Options={
  capability:DnsBenchmarkCapability;
  source:string;
  resolvers:{interface:string;address:string;family:number;supported:boolean;reason?:string}[];
  publicResolvers:{label:string;address:string}[];
  limits:typeof DNS_BENCHMARK_LIMITS;
};
type Preview={plan:DnsBenchmarkPlan;maxDurationMs:number;comparisons:number;lookupIterations:number;warning:string;body:Record<string,unknown>;key:string};
type Props={active:boolean;selectedJobId:string;jobs:Job[];blockedReason:string;onUpdated:()=>void;onCancel:(job:Job)=>void};
const when=(value:number)=>new Date(value).toLocaleString();
const items=(value:string)=>value.split(/[\s,]+/).filter(Boolean);
const ms=(value:number|null)=>value===null?'Not measured':value.toFixed(2)+' ms';
const setupUrl='https://github.com/norgan/neo-thc/blob/feat/dns-bench-integration/docs/dns-benchmark.md';

async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/v1/dns-benchmark/'+path,{signal,...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'}});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error??'DNS benchmark request failed');
  return data as T;
}

function defaults(options:Options){
  return [...new Set([...options.resolvers.filter(row=>row.supported).map(row=>row.address),...options.publicResolvers.map(row=>row.address)])];
}

export function DnsBenchmark({active,selectedJobId,jobs,blockedReason,onUpdated,onCancel}:Props){
  const [options,setOptions]=useState<Options|null>(null),[optionError,setOptionError]=useState(''),[reload,setReload]=useState(0);
  const [resolvers,setResolvers]=useState(''),[hostnames,setHostnames]=useState('example.com\ncloudflare.com\nquad9.net'),[port,setPort]=useState('53');
  const [protocols,setProtocols]=useState<('udp'|'tcp')[]>(['udp','tcp']),[recordTypes,setRecordTypes]=useState<('A'|'AAAA')[]>(['A','AAAA']);
  const [requests,setRequests]=useState('10'),[timeout,setTimeout]=useState('1');
  const [preview,setPreview]=useState<Preview|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [selectedId,setSelectedId]=useState('');
  const inFlight=useRef(false),requestId=useRef(crypto.randomUUID()),resolverEdited=useRef(false);
  const settingsKey=JSON.stringify([resolvers,hostnames,port,protocols,recordTypes,requests,timeout]);
  const currentKey=useRef(settingsKey);currentKey.current=settingsKey;
  const approvedPreview=preview?.key===settingsKey?preview:null;
  const history=jobs.filter(job=>job.synthetic===false&&!!job.spec.dnsBenchmark);
  const selected=history.find(job=>job.id===selectedId)??history[0];
  const chosenAddresses=new Set(items(resolvers).map(address=>canonicalAddress(address).toLowerCase()));
  const supportedSystem=options?.resolvers.filter(row=>row.supported)??[];
  const selectedSystem=supportedSystem.filter(row=>chosenAddresses.has(canonicalAddress(row.address).toLowerCase()));

  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    void api<Options>('options',undefined,controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      setOptions(value);setOptionError('');
      if(!resolverEdited.current)setResolvers(defaults(value).join('\n'));
    }).catch(()=>{if(!controller.signal.aborted)setOptionError('Could not read benchmark availability and system DNS configuration. Retry to refresh them.');});
    return()=>controller.abort();
  },[active,reload]);
  useEffect(()=>{setPreview(null);setConfirmed(false);requestId.current=crypto.randomUUID();},[settingsKey]);
  useEffect(()=>{if(selectedJobId)setSelectedId(selectedJobId);},[selectedJobId]);

  function useDefaults(){
    if(!options)return;
    resolverEdited.current=false;setResolvers(defaults(options).join('\n'));
  }
  async function review(){
    if(inFlight.current||blockedReason)return;
    inFlight.current=true;setBusy(true);setError('');setPreview(null);setConfirmed(false);
    const key=settingsKey;
    const body={requestId:requestId.current,hostnames:items(hostnames),resolvers:items(resolvers),port:Number(port),protocols,recordTypes,requests:Number(requests),timeoutSeconds:Number(timeout)};
    try{
      const result=await api<Omit<Preview,'body'|'key'>>('preview',body);
      if(currentKey.current===key)setPreview({...result,body,key});
    }catch(value){setError(value instanceof Error?value.message:'Could not review this benchmark.');}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function start(){
    if(!approvedPreview||!confirmed||!options?.capability.available||blockedReason||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{
      const {job}=await api<{job:Job}>('jobs',{...approvedPreview.body,confirmed:true});
      setSelectedId(job.id);requestId.current=crypto.randomUUID();setPreview(null);setConfirmed(false);onUpdated();
    }catch(value){setError(value instanceof Error?value.message:'Could not start this benchmark.');}
    finally{inFlight.current=false;setBusy(false);}
  }

  return <section className="panel dns-benchmark" aria-labelledby="dns-benchmark-title">
    <h3 id="dns-benchmark-title">DNS benchmark: system resolvers and IPv6</h3>
    <p>Compare your configured DNS servers with public candidates using repeated lookups. The default comparison includes IPv4 and IPv6 resolver addresses, A and AAAA records, and both UDP and TCP.</p>
    <p className="muted">Runs on the selected collector computer. NEO supplies the selected addresses directly to dns-bench, including system resolvers, so its Windows DNS discovery parser is bypassed. Nothing runs until you review and start.</p>
    {optionError&&<p className="error" role="alert">{optionError} <button disabled={busy} onClick={()=>setReload(value=>value+1)}>Retry benchmark availability</button></p>}
    {options&&!options.capability.available&&<div className="notice" role="status"><strong>DNS benchmark is unavailable on this collector.</strong>
      <p>{options.capability.reason??'The supported dns-bench executable is not available.'}</p>
      <p><a href={setupUrl} target="_blank" rel="noreferrer">DNS benchmark setup</a> · <button disabled={busy} onClick={()=>setReload(value=>value+1)}>Check benchmark availability again</button></p>
    </div>}
    {options?.capability.available&&<p className="muted">dns-bench {options.capability.version} is available.</p>}
    {options&&!selectedSystem.length&&<p className="caution" role="status">{!options.resolvers.length
      ?'No system resolver was detected. The selected comparison does not cover your configured DNS; enter its known address or retry discovery.'
      :!supportedSystem.length?'System DNS was detected, but none of its addresses can be benchmarked here. The selected comparison covers public or custom addresses only. Review the retained system entries for the missing capability.'
      :'None of the detected system DNS addresses is selected. Add your configured resolver to compare it with the public candidates.'}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <fieldset disabled={busy||!!blockedReason}><legend>Benchmark scope</legend>
      <label className="field">Benchmark DNS servers (up to 16 literal addresses)<textarea rows={4} value={resolvers} onChange={event=>{resolverEdited.current=true;setResolvers(event.target.value);}}/></label>
      <p className="muted">Every address listed receives the selected names. Public resolvers may bypass local filtering and split DNS; use public test names for this comparison. A resolver may forward them upstream.</p>
      {options&&<>
        <button onClick={useDefaults}>Use system and public resolvers</button>
        {items(resolvers).length>options.limits.maxResolvers&&<p className="caution">All detected and public addresses are retained. Select at most {options.limits.maxResolvers} for this run, then run another batch for the remaining addresses.</p>}
        <details><summary>Detected system DNS and public candidates</summary><p>{options.source}</p>
          <ul>{options.resolvers.map((row,index)=><li className="break" key={index}><strong>System:</strong> {row.address} · IPv{row.family} · {row.interface}
            {!row.supported&&<span> · Unavailable for this benchmark; retained as configuration evidence. {row.reason??'This address requires a supported interface scope.'}</span>}</li>)}</ul>
          <ul>{options.publicResolvers.map(row=><li className="break" key={row.address}>{row.label}: {row.address}</li>)}</ul>
        </details>
      </>}
      <label className="field">Benchmark DNS port<input type="number" min={1} max={65535} value={port} onChange={event=>setPort(event.target.value)}/></label>
      <label className="field">Benchmark hostnames (up to three)<textarea rows={3} value={hostnames} onChange={event=>setHostnames(event.target.value)}/></label>
      <div className="benchmark-choices">
        <fieldset><legend>DNS transport protocol</legend>{(['udp','tcp'] as const).map(protocol=><label className="check" key={protocol}>
          <input type="checkbox" checked={protocols.includes(protocol)} onChange={event=>setProtocols(current=>event.target.checked?[...current,protocol].sort():current.filter(value=>value!==protocol))}/>{protocol.toUpperCase()}</label>)}</fieldset>
        <fieldset><legend>Requested address records</legend>{(['A','AAAA'] as const).map(recordType=><label className="check" key={recordType}>
          <input type="checkbox" checked={recordTypes.includes(recordType)} onChange={event=>setRecordTypes(current=>event.target.checked?[...current,recordType].sort():current.filter(value=>value!==recordType))}/>{recordType==='A'?'A (IPv4 answers)':'AAAA (IPv6 answers)'}</label>)}</fieldset>
      </div>
      <p className="muted">The resolver address determines IPv4 or IPv6 transport. A and AAAA select the answers requested; an IPv4 resolver can return AAAA records and an IPv6 resolver can return A records.</p>
      <div className="benchmark-choices">
        <label className="field">Lookup iterations per comparison<input type="number" min={1} max={50} value={requests} onChange={event=>setRequests(event.target.value)}/></label>
        <label className="field">Request timeout (seconds)<input type="number" min={1} max={2} value={timeout} onChange={event=>setTimeout(event.target.value)}/></label>
      </div>
      <button disabled={!resolvers||!hostnames||!protocols.length||!recordTypes.length||items(resolvers).length>(options?.limits.maxResolvers??DNS_BENCHMARK_LIMITS.maxResolvers)} onClick={()=>void review()}>Review DNS benchmark</button>
    </fieldset>
    {approvedPreview&&<section className="notice" aria-labelledby="benchmark-preview-title"><h4 id="benchmark-preview-title">Review the DNS benchmark</h4>
      <p className="break"><strong>Names:</strong> {approvedPreview.plan.hostnames.join(', ')}</p>
      <p className="break"><strong>DNS recipients:</strong> {approvedPreview.plan.resolvers.join(', ')} · port {approvedPreview.plan.port}</p>
      <p>{approvedPreview.plan.protocols.map(value=>value.toUpperCase()).join(' + ')} · {approvedPreview.plan.recordTypes.join(' + ')} · {approvedPreview.plan.requests} iterations per comparison.</p>
      <p>{approvedPreview.comparisons} comparisons · up to {approvedPreview.lookupIterations} lookup iterations · maximum {approvedPreview.maxDurationMs/1000} seconds. Completed comparisons remain available if the run is interrupted.</p>
      <p>{approvedPreview.warning}</p>
      <label className="check"><input type="checkbox" checked={confirmed} disabled={busy||!!blockedReason} onChange={event=>setConfirmed(event.target.checked)}/>I approve this DNS benchmark and its listed recipients.</label>
      <button className="primary" disabled={!confirmed||busy||!!blockedReason||!options?.capability.available} onClick={()=>void start()}>Start approved DNS benchmark</button>
    </section>}
    <section className="benchmark-history" aria-labelledby="benchmark-history-title"><h4 id="benchmark-history-title">Saved DNS benchmarks</h4>
      {!history.length?<p className="muted">No DNS benchmark results yet.</p>:<>
        <label className="field">DNS benchmark history<select value={selected?.id??''} onChange={event=>setSelectedId(event.target.value)}>
          {history.map(job=><option key={job.id} value={job.id}>{when(job.createdAt)} · {job.spec.dnsBenchmark?.hostnames.join(', ')} · {job.status.replaceAll('_',' ')}</option>)}
        </select></label>
        {selected&&<>
          <p role="status">DNS benchmark {selected.status.replaceAll('_',' ')}{!selected.dnsBenchmarkReport?.complete||!['completed','completed_with_issues'].includes(selected.status)?' · Partial results; comparison is incomplete.':''}</p>
          {['running','queued'].includes(selected.status)&&<button onClick={()=>onCancel(selected)}>Cancel DNS benchmark</button>}
          {selected.errors.map((message,index)=><p className="caution" key={index}>{message}</p>)}
          {selected.dnsBenchmarkReport&&selected.spec.dnsBenchmark&&<BenchmarkReport plan={selected.spec.dnsBenchmark} report={selected.dnsBenchmarkReport} finished={['completed','completed_with_issues'].includes(selected.status)}/>}
        </>}
      </>}
    </section>
  </section>;
}

function summaries(plan:DnsBenchmarkPlan,report:DnsBenchmarkReport){
  const expected=plan.hostnames.length*plan.protocols.length*plan.recordTypes.length;
  return plan.resolvers.map(resolver=>{
    const rows=report.results.filter(row=>row.resolver===resolver),measured=rows.filter(row=>row.totalRequests!==null&&row.successfulRequests!==null);
    const attempts=measured.reduce((sum,row)=>sum+row.totalRequests!,0),successes=measured.reduce((sum,row)=>sum+row.successfulRequests!,0);
    const weighted=measured.reduce((sum,row)=>sum+(row.avgMs??0)*(row.successfulRequests??0),0);
    const rate=attempts>0?100*successes/attempts:null;
    const complete=rows.length===expected&&measured.length===expected;
    const reliable=report.complete&&complete&&attempts===plan.requests*expected&&successes===attempts;
    return {resolver,rows,expected,attempts,successes,rate,average:successes>0?weighted/successes:null,complete,reliable};
  }).sort((a,b)=>Number(b.reliable)-Number(a.reliable)||Number(b.complete)-Number(a.complete)||(b.rate??-1)-(a.rate??-1)||(a.average??Infinity)-(b.average??Infinity)||a.resolver.localeCompare(b.resolver));
}

function BenchmarkReport({plan,report,finished}:{plan:DnsBenchmarkPlan;report:DnsBenchmarkReport;finished:boolean}){
  const ranked=summaries(plan,report),winner=ranked.find(row=>row.reliable);
  const total=benchmarkComparisons(plan).length;
  const complete=finished&&report.complete;
  return <div className="benchmark-report">
    <p className="muted break">{report.vantage} · {report.tool} {report.toolVersion} · started {when(report.startedAt)} · updated {when(report.updatedAt)}</p>
    <progress aria-label="DNS benchmark comparisons" value={report.results.length} max={total}/>
    <p>{report.results.length}/{total} comparisons recorded · {plan.requests} lookup iterations per comparison.</p>
    {complete&&winner?<div className="notice"><h4>Lowest mean among fully successful tests</h4><p className="break"><strong>{winner.resolver}</strong> · {ms(winner.average)} · all {winner.expected} selected comparisons returned successful answers for every iteration.</p>
      <p>Compare its filtering, privacy and local-name behaviour before choosing it. This repeated-name sample includes resolver cache effects; it does not establish cold-cache performance, DNSSEC validation, encrypted DNS or every application's DNS path.</p></div>:
      <p className="notice">{complete?'No resolver passed every selected comparison. Review the failed or unavailable measurements before selecting a preferred resolver.':'The comparison is incomplete. Completed measurements are retained; no preferred resolver is selected yet.'}</p>}
    <h4>Resolver comparison</h4>
    <p className="muted">Full measurement coverage and success rate come before latency. Means are weighted by successful lookups; failed or missing measurements have no invented timing.</p>
    <div className="table-scroll" role="region" aria-label="DNS resolver comparison" tabIndex={0}><table><thead><tr><th scope="col">Resolver</th><th scope="col">Transport</th><th scope="col">Coverage</th><th scope="col">Successful lookups</th><th scope="col">Mean</th></tr></thead>
      <tbody>{ranked.map(row=><tr key={row.resolver}><th scope="row">{row.resolver}</th><td>IPv{row.resolver.includes(':')?'6':'4'}</td><td>{row.rows.length}/{row.expected}{!row.complete?' · incomplete measurements':''}</td>
        <td>{row.rate===null?'Not measured':row.successes+'/'+row.attempts+' ('+row.rate.toFixed(1)+'%)'}</td><td>{ms(row.average)}</td></tr>)}</tbody></table></div>
    <details><summary>Individual DNS benchmark measurements</summary><p className="muted">An absent AAAA record can produce no successful address response without an IPv6 transport fault. Use the targeted DNS checks to distinguish absent records, NXDOMAIN, refusal and timeout. The last returned address can reveal differences or filtering; successful resolution alone does not prove the expected answer, and the benchmark does not retain every iteration's answer.</p>
      <div className="table-scroll" role="region" aria-label="Individual DNS benchmark measurements" tabIndex={0}><table><thead><tr><th scope="col">Resolver</th><th scope="col">Hostname</th><th scope="col">Protocol</th><th scope="col">Record</th><th scope="col">Outcome</th><th scope="col">Success</th><th scope="col">Min</th><th scope="col">Mean</th><th scope="col">Max</th><th scope="col">Last answer</th></tr></thead>
        <tbody>{report.results.map((row,index)=><Measurement key={index} row={row}/>)}</tbody></table></div>
    </details>
    <p className="muted">Results describe the selected collector and network at the recorded time. A browser may use a separate secure-DNS provider. This benchmark does not change adapter DNS settings or validate all application behaviour.</p>
  </div>;
}

function Measurement({row}:{row:DnsBenchmarkResult}){
  return <tr><th scope="row">{row.resolver}</th><td>{row.hostname}</td><td>{row.protocol.toUpperCase()}</td><td>{row.recordType}</td>
    <td>{row.status.replaceAll('_',' ')}{row.issue&&<span className="benchmark-issue"> · {row.issue}</span>}</td>
    <td>{row.totalRequests===null||row.successfulRequests===null?'Not measured':row.successfulRequests+'/'+row.totalRequests}</td>
    <td>{ms(row.minMs)}</td><td>{ms(row.avgMs)}</td><td>{ms(row.maxMs)}</td><td>{row.lastResolvedAddress??'No address returned'}</td></tr>;
}
