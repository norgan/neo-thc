import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Asset, Job, Observation, Snapshot } from '../shared/types.js';
import './style.css';
import { Discovery } from './Discovery.js';

type Tab = 'Overview' | 'Inventory' | 'System' | 'Connections' | 'DNS' | 'Activity' | 'Discovery';
const tabs: Tab[] = ['Overview', 'Inventory', 'System', 'Connections', 'DNS', 'Activity', 'Discovery'];
const activeJob = (job: Job) => job.status === 'queued' || job.status === 'running';
const time = (timestamp: number) => new Date(timestamp).toLocaleString();

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Neo-Client': 'local-ui', ...options.headers },
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

function Badge({ value }: { value: string }) {
  return <span className={'badge ' + value}>{value.replaceAll('_', ' ')}</span>;
}

function Evidence({ observation }: { observation: Observation }) {
  return <div className="evidence">
    <div className="row"><strong>Observed result</strong><Badge value={observation.status} /></div>
    <p><strong>{observation.synthetic === false ? 'Network evidence' : 'Synthetic fixture'}</strong></p><p>{observation.note}</p>
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
  const [tab, setTab] = useState<Tab>('Overview');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ asset: Asset; observations: Observation[] } | null>(null);
  const [detailError, setDetailError] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [maxCycles, setMaxCycles] = useState(5);
  const [refresh, setRefresh] = useState(0);
  const initialized = useRef(false);
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await request<Snapshot>('/api/v1/snapshot', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setLoadError('');
        if (!initialized.current) {
          initialized.current = true;
          const allowed = next.targets.map((target) => target.key);
          const defaults = next.targets.filter((target) => target.defaultSelected !== false).map((target) => target.key);
          try {
            const saved = JSON.parse(localStorage.getItem('neo-demo-selection') ?? 'null') as unknown;
            if (Array.isArray(saved) && saved.every((item) => typeof item === 'string' && allowed.includes(item))) {
              setScope([...new Set(saved as string[])]);
            } else setScope(defaults);
          } catch { setScope(defaults); }
        }
      } catch {
        if (!controller.signal.aborted) setLoadError('The local API is unavailable. Displayed information may be out of date. Start the API, then retry.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 2_000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!initialized.current) return;
    try { localStorage.setItem('neo-demo-selection', JSON.stringify(scope)); } catch { /* Storage is optional. */ }
  }, [scope]);

  const latestEvidenceId = snapshot?.assets.find((asset) => asset.id === selected)?.latest?.id;
  useEffect(() => {
    setDetail(null);
    setDetailError('');
    if (!selected) return;
    const controller = new AbortController();
    void request<{ asset: Asset; observations: Observation[] }>('/api/v1/assets/' + encodeURIComponent(selected), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setDetail(data); })
      .catch(() => { if (!controller.signal.aborted) setDetailError('Could not load evidence. Retry or select another system.'); });
    return () => controller.abort();
  }, [selected, latestEvidenceId, refresh]);

  const running = snapshot?.jobs.find(activeJob);
  const networkView = tab === 'Discovery' || snapshot?.synthetic === false;
  const assets = snapshot?.assets ?? [];
  const currentAsset = assets.find((asset) => asset.id === selected) ?? detail?.asset;
  const observedProblem = assets.find((asset) => asset.latest?.services.some((service) => service.status === 'unhealthy'));
  const choose = (asset: Asset) => { setSelected(asset.id); setTab('System'); };

  async function start(mode: 'initial' | 'live') {
    if (busy || running) return;
    setBusy(true);
    setActionError('');
    const settings = { mode, scope: [...scope].sort(), exclusions: [...exclusions].sort(),
      intervalMs: 2_000, maxCycles: mode === 'initial' ? 1 : maxCycles, maxDurationMs: 30_000 };
    const fingerprint = JSON.stringify(settings);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, requestId: crypto.randomUUID() };
    try {
      await request('/api/v1/jobs', { method: 'POST', body: JSON.stringify({ ...settings, requestId: submission.current.requestId }) });
      submission.current = null;
      setRefresh((value) => value + 1);
      setTab('Activity');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start collection');
    } finally { setBusy(false); }
  }

  async function cancel(job: Job) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await request('/api/v1/jobs/' + encodeURIComponent(job.id) + '/cancel', { method: 'POST', body: '{}' });
      setRefresh((value) => value + 1);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not cancel collection'); }
    finally { setBusy(false); }
  }

  return <div className="shell">
    <header className="masthead">
      <div><div className="eyebrow">THE HOMELAB COMPANION</div><h1>neo<span>THC</span></h1>
        <p>Network Environment Overview</p></div>
      <div className="local-label"><span className="dot" /> Local-first foundation<br /><strong>{networkView ? 'Opt-in network discovery' : 'Synthetic demo only'}</strong></div>
    </header>
    <div className="notice">{networkView
      ? 'Network discovery runs only for explicitly confirmed local IPv4 scopes. Address candidates and advertisements do not establish device identity or health. Synthetic fixtures stay separately labelled.'
      : 'This view includes synthetic fixtures. Real network requests require a separate scope preview and confirmation in Discovery. Live fixture updates do not send network traffic.'}</div>
    <nav aria-label="Main navigation">{tabs.map((item) =>
      <button key={item} className={item === tab ? 'selected' : ''} aria-current={item === tab ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</nav>
    <main>
      <div aria-live="polite">
        {loadError && <div className="error">{loadError} <button onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>}
        {actionError && <div className="error">{actionError}</div>}
        {snapshot?.collectionError && <div className="error">{snapshot.collectionError}</div>}
      </div>
      {!snapshot && !loadError && <p role="status">Loading the local overview…</p>}

      {tab === 'Overview' && <>
        <div className="section-title"><div><div className="eyebrow">A QUIETER VIEW OF YOUR LAB</div><h2>Start with what we know.</h2></div><Badge value={snapshot?.synthetic === false ? "network-and-fixture-evidence" : "fixture-only"} /></div>
        <div className="stats">
          <div><strong>{assets.length}</strong><span>inventory entries</span></div>
          <div><strong>{assets.filter((asset) => asset.freshness === 'fresh').length}</strong><span>fresh observations</span></div>
          <div><strong>{assets.filter((asset) => asset.identityWarnings.length > 0).length}</strong><span>identity cautions</span></div>
        </div>
        <div className="columns"><section className="panel">
          <h3>One small next step</h3><p>Choose demo systems, then collect one snapshot. Start periodic fixture updates when you want to explore changing freshness.</p>
          <fieldset disabled={busy || !!running || !snapshot || !!snapshot.collectionError}>
            <legend>Explicit fixture scope</legend>
            {snapshot?.targets.map((target) => <label className="check" key={target.key}>
              <input type="checkbox" checked={scope.includes(target.key)} onChange={(event) => {
                setScope((previous) => event.target.checked ? [...previous, target.key] : previous.filter((key) => key !== target.key));
                setExclusions((previous) => previous.filter((key) => key !== target.key));
              }} /> {target.label}
            </label>)}
            <details><summary>Limits and exclusions</summary>
              <label className="field">Live cycles (1–15, two seconds apart)
                <input type="number" min={1} max={15} value={maxCycles} onChange={(event) => setMaxCycles(Number(event.target.value))} />
              </label>
              <p className="muted">One job at a time. A 30-second total deadline. At most 750 ms per fixture target. Useful partial results are saved.</p>
              {scope.map((key) => <label className="check" key={key}>
                <input type="checkbox" checked={exclusions.includes(key)} onChange={(event) =>
                  setExclusions((previous) => event.target.checked ? [...previous, key] : previous.filter((item) => item !== key))} />
                Exclude {snapshot?.targets.find((target) => target.key === key)?.label}
              </label>)}
            </details>
            <div className="actions"><button className="primary" disabled={!scope.some((key) => !exclusions.includes(key))} onClick={() => void start('initial')}>Collect initial fixtures</button>
              <button disabled={!scope.some((key) => !exclusions.includes(key)) || !Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 15} onClick={() => void start('live')}>Start live fixtures</button></div>
          </fieldset>
          {running && <p role="status">A collection is active. <button onClick={() => setTab('Activity')}>View progress</button></p>}
          <p className="muted">This fixture selection is saved in this browser. Discovery uses a separate, unsaved explicit network scope.</p>
        </section>
        <section className="panel">
          <h3>Evidence before conclusions</h3>
          {observedProblem ? <><div className="row"><strong>Demo storage: NFS needs attention</strong><Badge value={observedProblem.freshness} /></div>
            <p>The fixture records failed NFS alongside healthy ping and SMB. The cause and any downstream impact are unknown.</p>
            <p>Freshness applies to this evidence. A stale result does not prove the service is currently failing.</p>
            <button onClick={() => choose(observedProblem)}>Inspect storage evidence</button></> :
            <p>After your first collection, inspect the storage example: NFS can fail while ping and SMB still work.</p>}
          <hr /><h3>Keep the effort visible</h3>
          <dl><dt>Setup</dt><dd>One local app; no accounts or credentials.</dd>
            <dt>Maintenance</dt><dd>Fixture updates stop automatically. Old evidence becomes stale.</dd>
            <dt>Recovery</dt><dd>Interrupted jobs retain partial results. Start a new job to continue collecting.</dd></dl>
          <p className="muted">Guided real-world recommendations, dependencies, and saved diagnostic steps are still planned.</p>
        </section></div>
      </>}

      {tab === 'Inventory' && <section>
        <div className="section-title"><h2>Your inventory</h2><span className="muted">{assets.length} inventory entries</span></div>
        {assets.length === 0 && <div className="panel"><h3>No observations yet</h3><p>Collect initial fixtures from Overview to build the inventory.</p><button onClick={() => setTab('Overview')}>Choose fixture scope</button></div>}
        <div className="asset-grid">{assets.map((asset) => <article className="panel" key={asset.id}>
          <div className="eyebrow">{asset.kind}</div><h3>{asset.label}</h3>
          <div className="badges"><Badge value={asset.health} /><Badge value={asset.freshness} /></div>
          <p>{asset.latest?.identifiers.find((identifier) => identifier.kind === 'ip')?.value ?? 'No address evidence'}</p>
          <p className="muted">{asset.latest?.synthetic === false ? 'Network address candidate' : 'Synthetic fixture'} · {asset.latest?.source}</p>
          {asset.identityWarnings.length > 0 && <p className="caution">Address reuse or identity ambiguity. Evidence is kept separate.</p>}
          <button onClick={() => choose(asset)}>Inspect system</button>
        </article>)}</div>
      </section>}

      {tab === 'System' && <section>
        <div className="section-title"><h2>{currentAsset?.label ?? 'System evidence'}</h2>
          <button onClick={() => setTab('Inventory')}>Back to inventory</button></div>
        {!selected && <div className="panel">Choose a system from Inventory to view its evidence.</div>}
        {detailError && <div className="error" role="alert">{detailError} <button onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>}
        {selected && !detail && !detailError && <p role="status">Loading evidence…</p>}
        {detail && currentAsset && <div className="columns">
          <section className="panel"><h3>Identity and current confidence</h3>
            <div className="badges"><Badge value={currentAsset.health} /><Badge value={currentAsset.freshness} /></div>
            <dl><dt>Internal ID</dt><dd className="break">{currentAsset.id}</dd><dt>Identity basis</dt><dd>{currentAsset.identityConfidence}</dd></dl>
            <p className="muted">IP and MAC evidence never merge assets automatically. An identity verified by one source is not global certainty.</p>
            {currentAsset.identityWarnings.map((warning) => <p className="caution" key={warning}>{warning}</p>)}
            {currentAsset.latest && <Evidence observation={currentAsset.latest} />}
          </section>
          <section className="panel"><h3>Observation history</h3><p className="muted">Latest 100 observations, newest observation time first. Earlier and conflicting claims remain stored.</p>
            {detail.observations.map((observation) => <details key={observation.id}><summary>{time(observation.observedAt)} · {observation.status}</summary>
              <Evidence observation={observation} /></details>)}
          </section>
        </div>}
      </section>}

      {tab === 'Discovery' && <Discovery disabled={busy || !!running || !!snapshot?.collectionError}
        onStarted={() => { setRefresh((value) => value+1);setTab('Activity'); }} />}

      {tab === 'Connections' && <section className="panel"><div className="eyebrow">PLANNED</div><h2>Connections need their own safety boundary.</h2>
        <p>No device integrations are installed or connected. UniFi, OPNsense, and Proxmox are the first planned adapters; QNAP and Nextcloud require later capability checks.</p>
        <p>Future connections need product/version checks, explicit scopes, reviewed read-only operation allowlists, and local secret storage. A product name is not authorization.</p>
        <p className="muted">There is no credential form in this version.</p></section>}

      {tab === 'DNS' && <section className="panel"><div className="eyebrow">PLANNED</div><h2>DNS without accidental disclosure.</h2>
        <p>No DNS queries run automatically. Discovery supports explicit-resolver PTR queries and opt-in mDNS service-type advertisements. Broader resolver diagnostics remain planned.</p>
        <p>Local home.arpa naming and multicast .local have different behavior. Resolver advertising, observed endpoints, upstreams, and application overrides need separate evidence.</p>
        <p className="muted">Local DNS planning and external-query confirmation are still to be implemented.</p></section>}

      {tab === 'Activity' && <section>
        <div className="section-title"><h2>Collection activity</h2><button onClick={() => setTab('Overview')}>New collection</button></div>
        {snapshot?.jobs.length === 0 && <div className="panel">No jobs yet. Start with a single fixture collection.</div>}
        <div className="job-list">{snapshot?.jobs.map((job) => <article className="panel" key={job.id}>
          <div className="row"><h3>{job.spec.discovery ? 'Approved IPv4 discovery' : job.spec.mode === 'initial' ? 'Initial fixtures' : 'Live fixture updates'}</h3><Badge value={job.status} /></div>
          <p className="muted">{time(job.createdAt)} · {job.spec.scope.length - job.spec.exclusions.length} selected targets</p>
          <progress aria-label="Collection progress" value={job.discoveryProgress?.addressesCompleted ?? job.completedTargets} max={job.spec.discovery?.targets.length ?? job.totalTargets} />
          {job.spec.discovery && <p>{job.discoveryProgress?.addressesCompleted ?? 0} / {job.spec.discovery.targets.length} address attempts · TCP {job.discoveryProgress?.tcpCompleted ?? 0}/{job.spec.discovery.tcpBudget} · PTR {job.discoveryProgress?.dnsCompleted ?? 0}/{job.spec.discovery.dnsBudget}. Address candidates are not a confirmed device count.</p>}
          <p>{job.completedTargets} / {job.totalTargets} target attempts · {job.cyclesCompleted} cycles · {job.observationsAdded} observations saved</p>
          {job.errors.map((error, index) => <p className="caution" key={index}>{error}</p>)}
          {activeJob(job) && <button disabled={busy} onClick={() => void cancel(job)}>Cancel collection</button>}
          {['cancelled', 'timed_out', 'interrupted'].includes(job.status) && <p>Partial evidence is retained. Start a new job when you are ready.</p>}
        </article>)}</div>
      </section>}
    </main>
    <footer>Neo · Network Environment Overview <span>THC · The Homelab Companion</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
