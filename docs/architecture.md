# Foundation architecture and collector extension

## Implemented source boundary

A single local Node 24 process serves the Fastify API and production React files. SQLite records assets, immutable normalized observations, and job snapshots. A compiled-in FixtureCollector produces documented synthetic examples without any network or OS discovery calls. The browser polls a snapshot every two seconds without overlapping its own polls.

This is the first source draft. It has not been executed. The wider requirements remain in requirements.md.

### Main modules

- shared/types.ts: API model, evidence, identities and job lifecycle
- server/collector.ts: narrow adapter contract and six deterministic scenarios
- server/store.ts: SQLite schema v1, transactional observation writes, source-scoped identity and evidence projection
- server/jobs.ts: input validation, idempotent submission, concurrency slot, bounded scheduler and cancellation
- server/app.ts: loopback-facing API and built static files; sanitized errors and browser-origin guards
- server/main.ts: fixed loopback listener, database path and shutdown
- web/main.tsx: responsive inventory/evidence UI, explicit fixture controls, saved selection and planned-feature screens

## Identity and evidence

Every newly encountered source + subjectKey gets an opaque internal UUID. IP/MAC values are evidence only. Repeated observations for a source-scoped key enrich the same asset; the same address on another key creates a separate asset. Latest claims shared across assets show an ambiguity warning, including the historical/current address reuse scenario. This is intentionally not automatic cross-source reconciliation.

The SQLite observation ID deduplicates repeated delivery. Each record includes source, vantage, observedAt, receivedAt, ttlMs, status, identifiers and service evidence. History is not replaced. Current-health projection returns unknown once evidence is stale, while preserving its original observed status. A stopped result is explicit; missing or stale collection never implies a device is stopped or unhealthy.

Duplicate events are skipped by ID. The only producer is a trusted fixture. Before accepting external observations, add runtime schema validation, payload-size/time bounds, duplicate-ID payload conflict handling, issuer binding and persistent identity-conflict records.

The NFS example reports only a synthetic NFS failure, ping success and SMB success. There is no asserted root cause or downstream dependency impact. Dependency graph, findings grouping and recommendation persistence are deferred.

## Job API

All routes are under /api/v1:

- GET /health: process health and fixture-only designation
- GET /snapshot: synthetic marker, assets, jobs and allowed fixture targets
- GET /assets: projected inventory
- GET /assets/:id: asset plus latest 100 evidence records
- GET /jobs and /jobs/:id: progress and immutable submission settings
- POST /jobs: submit fixture collection
- POST /jobs/:id/cancel: request cooperative cancellation; repeated cancellation is harmless

Mutation requests require JSON and X-Neo-Client: local-ui. Host must exactly match a supported localhost/127.0.0.1 app port; browser Origin, when present, must match those local origins. Cross-origin requests receive no CORS allowance. Requests are limited to 8 KiB. These are local browser-exposure defenses, not authentication.

Example submission:

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

No addresses, CIDRs, platform URLs or credentials are accepted as targets. Only six enumerated fixture keys are valid. Exclusions must belong to scope; at least one target must remain. Request keys and targets are validated strictly. Scope/exclusions are sorted and copied into the job.

Initial mode requires one cycle. Live allows 1–60 cycles, 1–30 second intervals and a 1–60 second total lifetime; the UI uses a 30-second lifetime and caps its cycle control at 15. Collection ends at the earlier cycle/lifetime bound. The interval is a delay between complete cycles, not a fixed-rate guarantee.

An identical requestId and normalized settings returns the same persisted job (including after completion); different settings for that key return 409. There is one active slot, no unbounded waiting queue. Other concurrent submissions return 409. Each target call has a 750 ms deadline, then later targets continue; an unresolved promise cannot prevent cancellation or whole-job timeout. Adapter errors are reduced to a fixed message. Late results are ignored.

Terminal states: completed, cancelled, timed_out, interrupted, failed. A target error makes the terminal job failed with partial results preserved. Shutdown aborts and awaits the active runner before closing SQLite. On restart, queued/running records become interrupted. A new request starts a new job; there is no implicit replay or live-job resumption.

Total target attempts, completed attempts, cycles and accepted observation counts are separate. A timeout/cancellation can leave progress below 100%, intentionally.

## Storage and operating limits

SQLite uses foreign keys, WAL, bound statements, a 1-second busy timeout and atomic observation batches. Internal job JSON is saved after each attempted target and cycle. Schema version 1 is recorded; a newer version is rejected. Run only one application process against a database. There is no multi-process job coordinator.

The scheduler caps retained job count at 200 and ingest caps observations at 10,000. Capacity failures keep existing data, report collection failure, and do not silently remove evidence. Growth is bounded for this fixture implementation; a production system needs a designed retention/export policy and bounded adapter payloads.

The data directory is created with mode 0700 when newly created on supporting systems. Files inherit process umask; no encryption or secret vault is implemented. Avoid shared hosts and use OS-level disk/access protections before storing any real topology. Browser storage contains only selected fixture keys.

## Future collectors and optional endpoint agent

The adapter seam is deliberately small: identity, advertised fixture capability, target descriptors and collect(target, context). Context includes an AbortSignal, observation timestamp and cycle. There are no mutation, configuration, shell, remediation or credential methods.

Do not plug a real platform into this in-process implementation. Required next design:
1. Move collectors into killable isolated workers/processes with independent wall-clock and resource limits. A CPU loop can block this initial in-process scheduler.
2. Validate every observation at the process boundary. Bind source/vantage to registered adapter identity rather than trusting payload claims.
3. Define explicit scopes, exclusions, protocols and destination allowlists; discovery never expands them.
4. Verify per-product/version read-only operations. HTTP GET alone is insufficient, especially for OPNsense.
5. Keep encrypted/local secret references separate from inventory; redact all errors and logs and avoid secret-bearing browser payloads.
6. Add trust, authentication, enrollment/revocation and replay protection before accepting a remote agent.
7. An optional endpoint agent should report narrowly allowed local inventory/observations, use signed/versioned messages and bounded batches, and run without remote command/configuration capabilities.
8. Keep agent deployment a later explicit decision. This repository contains no agent runtime, installer, enrollment, network listener for agents, or remote execution protocol.

## Executive-function support

The current UI keeps a single next step visible, groups the NFS evidence, saves scope selection, makes automatic stop limits clear, and separates setup/maintenance/recovery effort. Planned guidance should persist progress, explain prerequisites and alternatives, avoid a single security/privacy score, and distinguish certainty from inference. Full guided diagnostics and save/resume workflows remain deferred.

## API and dependency references

Official sources reviewed while authoring:
- [Node 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): DatabaseSync, exec, prepared statements and timeout option. SQLite remains experimental/active-development on Node 24.
- [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/): listen, request/body limits, hooks, injection and close.
- [Fastify 5.12.5](https://github.com/fastify/fastify/releases/tag/v5.12.5): patched exact pin.
- [Vite 7.3.7](https://github.com/vitejs/vite/releases/tag/v7.3.7) and [server options](https://vite.dev/config/server-options): Node-compatible pin, explicit host, strictPort and proxy.
- [React 19.2.0](https://github.com/facebook/react/releases/tag/v19.2.0): browser React / react-dom pair. This app does not use React Server Components.
- [TypeScript 5.9.3](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3) and [tsx 4.20.6](https://github.com/privatenumber/tsx/releases/tag/v4.20.6).

Exact direct pins and compatible major contracts do not establish a passing install, compilation or vulnerability audit. All runtime verification is outstanding.
