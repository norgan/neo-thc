## Current runtime correction

The production app is real-only (playback-desktop-v7): NOC/Systems/Network/Diagnostics/System/Activity/Settings, with discovery in a secondary modal and no fixture collection route. Optional existing Glances enrichment is part of the reviewed discovery job only when explicitly enabled. Synthetic legacy database rows are retained but excluded before evidence projection, ambiguity summaries and capacity checks. Tests inject fixtures from tests/support; production build excludes that directory. Interface/CIDR/DNS defaults come from bounded local configuration reads, never network queries. Method diagnostics are host-validated and partial completion remains explicit.

The [home support workbench](diagnostics.md) uses exact scope/approval and the shared job manager. Targeted DNS/TCP/TLS uses a fixed isolated worker. The Internet runner owns abortable native DNS/HTTPS requests and fixed, bounded OS ping/settings subprocesses directly so cancellation can kill and await their closure; it disables further collection if process cleanup cannot be confirmed. Only fixed YouTube/Netflix names and fixed Cloudflare ping/MTU/download recipients are built into the media profile; optional gateway and DNS recipients are explicit literals. Reports stay in existing job JSON (schema v2), preserving partial results and interruption recovery without creating inventory assets. No network setting is changed. Constructor-only probe injection supports isolated tests and is unavailable over HTTP.

# Foundation architecture and collector extension

## Implemented source boundary

A single local Node 24 process serves the Fastify API and production React files. SQLite records assets, immutable normalized observations, and job snapshots. The default DiscoveryCollector uses fixed scoped TCP/DNS/UDP operations; opening the UI or previewing scope sends no probes. The browser polls a snapshot every two seconds without overlapping its own polls.

The original collector milestone passed 26 unit tests and 12 desktop/mobile Chromium cases. The 14 October continuation passed 74 unit tests, 28 browser cases, typechecks and build locally on Windows; see [testing](testing.md) and current PR checks for exact evidence and operating-system limits. The wider requirements remain in requirements.md.

### Main modules

- shared/types.ts: API model, evidence, identities and job lifecycle
- server/collector.ts: narrow adapter contract; deterministic collectors live under tests/support
- server/discovery-runner.ts and discovery-worker.mjs: fixed real worker lifecycle, parent validation and trusted provenance
- server/discovery-scope.ts, discovery-network.mjs and discovery-protocols.mjs: scope/budget validation, bounded real transports and packet parsers
- server/glances-enrichment.ts, glances-mdns.mjs and glances-worker.mjs: consented bounded endpoint resolution, revalidation and enrichment
- server/glances.ts: fixed six-path, source-bound HTTP/HTTPS stats transport and normalization
- server/store.ts: SQLite schema v3 (additive transactional stats history), transactional observation writes, source-scoped identity and evidence projection
- server/jobs.ts: input validation, idempotent submission, concurrency slot, bounded scheduler and cancellation
- server/app.ts: loopback-facing API and built static files; sanitized errors and browser-origin guards
- server/main.ts: fixed loopback listener, database path and shutdown
- web/main.tsx, Discovery.tsx and SystemStats.tsx: NOC, systems/network/evidence views, consented discovery modal and stats controls
- scripts/smoke.mjs: bounded Linux CI check of npm start, production assets, actual compiled loopback TCP/Glances transports and clean shutdown

## Desktop and split collector placement

The desktop bundles Electron with an owned Node utility process and serves its packaged UI on loopback. Standalone owns SQLite and discovery locally. Remote mode owns a local fixed-route proxy and native device checks, while the explicitly selected authenticated TLS service owns storage, network diagnostics and discovery. Credentials stay outside the renderer; optional persistence requires protected OS encryption. Every discovery scope remains collector-validated and explicitly approved. See [placement and trust boundary](deployment-modes.md) and [deployment instructions](../deploy/README.md). No hosted control plane, multi-user roles or real second-host deployment is claimed.

Playback uses the user-activated browser companion, schema-validated report preview/import and an additive bounded history table. It reads the actual existing browser video element without moving Netflix into Electron or collecting account/media data. Native Windows Wi-Fi retains only normalized signal/link fields. See [playback diagnosis](playback.md).

## Discovery vertical slice

See [explicit-scope discovery](discovery.md). The discovery modal and /api/v1/discovery options/preview/jobs routes never use the test-only fixture submission path. The server enumerates eligible local IPv4 interfaces for user selection and normalizes a bounded on-link CIDR/method/port plan. The shared JobManager maintains one global active slot, also reserved during optional Glances resolution and reads.

The discovery-scope module validates current interface/scope and budgets. discovery-protocols.mjs parses bounded untrusted replies; discovery-network.mjs owns fixed TCP/DNS/UDP calls; discovery-worker.mjs runs them inside the killable worker. discovery-runner.ts validates messages and constructs job-scoped address-candidate observations with explicit real/synthetic provenance. No adapter credentials or hosted transport are introduced.

## Identity and evidence

Every newly encountered source + subjectKey gets an opaque internal UUID. IP/MAC values are evidence only. Repeated observations for a source-scoped key enrich the same asset; the same address on another key creates a separate asset. Latest claims shared across assets show an ambiguity warning, including the historical/current address reuse scenario. This is intentionally not automatic cross-source reconciliation.

The SQLite observation ID deduplicates repeated delivery. Each record includes source, vantage, observedAt, receivedAt, ttlMs, status, identifiers and service evidence. History is not replaced. Current-health projection returns unknown once evidence is stale, while preserving its original observed status. A stopped result is explicit; missing or stale collection never implies a device is stopped or unhealthy.

Duplicate events are skipped by ID. The production discovery parent validates bounded worker results and assigns provenance. The simulated Proxmox worker lives in test support only. Before accepting externally submitted observations, add secure transport/issuer binding, duplicate-ID payload conflict handling and persistent identity-conflict records.

The NFS example reports only a synthetic NFS failure, ping success and SMB success. There is no asserted root cause or downstream dependency impact. Dependency graph, findings grouping and recommendation persistence are deferred.

## Job API

All routes are under /api/v1:

- GET /health: process health, current runtime and collection availability
- GET /snapshot: real-only assets, system projections, stats, active reads and jobs
- GET /assets: projected inventory
- GET /assets/:id: asset plus latest 100 evidence records
- GET /jobs and /jobs/:id: progress and immutable submission settings
- POST /jobs/:id/cancel: request cancellation and worker termination; repeated cancellation is harmless
- GET /discovery/options: current eligible interfaces and bounded local DNS defaults
- POST /discovery/preview and /discovery/jobs: validate or explicitly submit a fixed scoped plan
- POST /assets/:id/glances/preview and /assets/:id/glances/read: review or consent to one fixed stats endpoint
- POST /stats/:id/cancel: cancel the active manual stats read

Mutation requests require JSON and X-Neo-Client: local-ui. In local mode Host/Origin match supported localhost/127.0.0.1 ports. The separate service entry point requires TLS, the configured HTTPS Host/Origin and an administrative bearer token on every route. There is no CORS allowance. Existing job requests stay limited to 8 KiB; strictly validated playback imports allow 64 KiB. The desktop proxy accepts only fixed existing API routes, with a 64 KiB request and 4 MiB response cap; tokens and server configuration never enter the renderer. Local browser guards are exposure defenses, not authentication.

Historical test-only fixture submission (POST /jobs is absent from production):

```json
{
  "requestId": "example-request-0001",
  "mode": "live",
  "scope": ["fixture:nas", "fixture:gateway"],
  "exclusions": [],
  "intervalMs": 2000,
  "maxCycles": 5,
  "maxDurationMs": 30000
}
```

The test-only fixture submission endpoint accepts no addresses, CIDRs, platform URLs or credentials as targets. It is installed only by the explicit test-support app. The production discovery endpoint accepts only its validated local IPv4 plan; see discovery.md. Fixture keys, scope/exclusions and cycle behavior below describe the test scheduler, not a normal runtime feature.

Initial mode requires one cycle. Live allows 1–60 cycles, 1–30 second intervals and a 1–60 second total lifetime; the UI uses a 30-second lifetime and caps its cycle control at 15. Collection ends at the earlier cycle/lifetime bound. The interval is a delay between complete cycles, not a fixed-rate guarantee.

An identical requestId and normalized settings returns the same persisted job (including after completion); different settings for that key return 409. There is one active slot, no unbounded waiting queue. Other concurrent submissions return 409. Each target call has a 750 ms deadline including worker startup, then later targets continue after worker termination. Synchronous CPU loops and unresolved promises inside that worker cannot prevent parent-side cancellation or whole-job timeout. Adapter errors are reduced to a fixed message. Late results are ignored.

Terminal states: completed, completed_with_issues, cancelled, timed_out, interrupted, failed. Bounded per-method issues can preserve useful evidence with completed_with_issues; a collector/worker failure remains failed. Shutdown cancels stats and the active job in preClose, while pending HTTP responses can still finish. It awaits collection cleanup, closes remaining browser connections, and closes SQLite in onClose. This follows the [Fastify close lifecycle](https://fastify.dev/docs/latest/Reference/Server/#close) and handles unused preconnections and incomplete requests without waiting for their normal network timeouts. Storage-write failures are consumed by the background runner, release the active slot, disable new collection, and expose a collectionError in health/snapshot responses. The UI warns that activity may be incomplete; Neo does not claim that an unsaved terminal state was persisted. On restart, queued/running records become interrupted. A new request starts a new job; there is no implicit replay or live-job resumption.

Total target attempts, completed attempts, cycles and accepted observation counts are separate. A timeout/cancellation can leave progress below 100%, intentionally.

## Storage and operating limits

SQLite uses foreign keys, WAL, bound statements, a 1-second busy timeout and atomic observation batches. Internal job JSON is saved after each attempted target and cycle. Schema version 2 adds stats snapshots transactionally; versions above 3 are rejected. Run only one application process against a database. There is no multi-process job coordinator.

The scheduler caps visible job count at 200, visible observations at 10,000 and stats snapshots at 500. Quarantined synthetic rows do not consume real discovery capacity. Capacity failures keep existing data, report collection failure, and do not silently remove evidence. A long-running installation still needs a designed retention/export policy.

The data directory is created with mode 0700 when newly created on supporting systems. Inventory and report databases remain unencrypted; protect real metadata using host disk/access controls. Optional remembered desktop service tokens use protected OS safeStorage encryption and reject basic_text storage. Service token/private-key files require owner-controlled permissions. Discovery modal edits persist in component memory while the page stays open; closing it clears consent.

## Future collectors and optional endpoint agent

Agentless APIs/protocols are preferred; any endpoint agent must justify a missing capability rather than becoming the default. Site-collector placement is independent of that endpoint-agent choice.

The adapter seam is deliberately small: identity, advertised fixture capability, target descriptors and collect(target, context). Context includes an AbortSignal, observation timestamp, cycle, deadline and bounded-batch callback. There are no mutation, configuration, shell, remediation or credential methods.

The fixed-worker foundation is described in [collector isolation](collector-isolation.md). Required before a real integration:
1. Add a carefully reviewed platform API transport, with credential/destination/TLS policy and operating-system isolation where needed. The Node worker is not a security sandbox.
2. Bind authenticated source identity and permission/version discovery to registered integration policy; test against supported live platforms.
3. Define explicit scopes, exclusions, protocols and destination allowlists; discovery never expands them.
4. Verify per-product/version read-only operations. HTTP GET alone is insufficient, especially for OPNsense.
5. Keep encrypted/local secret references separate from inventory; redact all errors and logs and avoid secret-bearing browser payloads.
6. Implement the reviewed site pairing, trust/authentication, revocation, replay-safe delivery and local authorization policy before split deployment; these are separate from optional endpoint-agent enrollment.
7. Only when an approved capability cannot be obtained agentlessly, an optional endpoint agent may report narrowly allowed local inventory/observations, using authenticated/versioned messages and bounded batches, without remote command/configuration capabilities.
8. Keep agent deployment a later explicit decision. This repository contains no agent runtime, installer, enrollment, network listener for agents, or remote execution protocol.

## Executive-function support

The NOC prioritizes observed systems and capacity, keeps discovery secondary, preserves modal edits, explains blocking fields and makes automatic stop limits clear. Historical stats and ambiguous identities remain visible. Planned guidance should persist progress, explain prerequisites and alternatives, avoid a single security/privacy score, and distinguish certainty from inference. Full dependency analysis, guided diagnostics and save/resume workflows remain deferred.

## API and dependency references

Official sources reviewed while authoring:
- [Node 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): DatabaseSync, exec, prepared statements and timeout option. SQLite remains experimental/active-development on Node 24.
- [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/): listen, request/body limits, hooks, injection and close.
- [Fastify 5.12.5](https://github.com/fastify/fastify/releases/tag/v5.12.5): patched exact pin.
- [Vite 7.3.7](https://github.com/vitejs/vite/releases/tag/v7.3.7) and [server options](https://vite.dev/config/server-options): Node-compatible pin, explicit host, strictPort and proxy.
- [React 19.2.0](https://github.com/facebook/react/releases/tag/v19.2.0): browser React / react-dom pair. This app does not use React Server Components.
- [TypeScript 5.9.3](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3) and [tsx 4.20.6](https://github.com/privatenumber/tsx/releases/tag/v4.20.6).

Exact direct pins alone do not establish compatibility or safety. The authentic generated lockfile is committed and CI uses npm ci. See [testing](testing.md) and [browser testing](browser-testing.md) for evidence and unverified areas.


The semantic inventory is a presentation projection over independent discovery records. Glances is the first opt-in production HTTP adapter: a user-approved single endpoint, six fixed read-only paths, direct source-bound requests and no credentials. Stats use a separate bounded local table and share discovery capacity. See [Glances transport and upgrade boundary](glances.md). Authenticated platform integrations and remote control remain planned.
