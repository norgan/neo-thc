# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first companion for understanding a home network and homelab through one responsive desktop and mobile web interface.

## Status: fixture foundation with passing automated checks

This branch contains a TypeScript / Fastify / SQLite / React foundation. **The collector milestone passed 26 unit tests, 12 desktop/mobile Chromium cases, typechecks, production build and startup smoke** on 13 October 2026 ([recorded run](https://github.com/norgan/neo-thc/actions/runs/38334676302), source head d459b88e). That smoke includes the real compiled worker. A subsequent review correction adds a late-batch regression (27 unit tests total); read current PR checks for the final head result. Physical-device QA, comprehensive accessibility review, real integrations and deployment remain unverified.

All device data is synthetic. “Initial” performs one fixture pass; “live” periodically repeats fixture observations. Neither mode scans the network, queries DNS, connects to platforms, reads local network interfaces, or collects credentials.

The original [requirements baseline](docs/requirements.md) is preserved. It describes the wider product, including features still planned.

## Quick start

Prerequisite: **Node.js 24.x** with npm. The engine intentionally excludes other Node majors. SQLite uses built-in `node:sqlite` (experimental/active-development in Node 24); no SQLite native addon is needed.

From the repository root:

```sh
npm ci
npm run check
npm start
```

Then open **http://127.0.0.1:4318**. Select demo systems in Overview and choose **Collect initial fixtures**. Use Inventory / System for evidence and Activity for progress or cancellation.

These are local setup instructions. CI has checked the production startup path on Linux; your own environment still needs verification. Installation downloads npm packages. Direct and transitive dependencies are locked in the genuine npm-generated package-lock.json retrieved from the successful CI artifact, digest-checked and committed unchanged. Use `npm ci` to install that resolution. See [verification provenance](docs/testing.md).

## Development

Use two terminals, both at the repository root:

```sh
npm run dev:api
npm run dev:web
```

Open **http://127.0.0.1:5173**. Vite proxies /api to the loopback API on port 4318. No React-specific Vite plugin is required for this starter; JSX uses the automatic transform.

Commands:
- `npm run typecheck`: server, tests, shared types, and browser type checks
- `npm test`: Node test runner via tsx; isolated databases and API injection, no real probes
- `npm run build`: TypeScript server output plus Vite browser build
- `npm run check`: typecheck, tests, then build
- `npm run smoke`: Linux-only bounded production-startup/API check, after build; uses a temporary database and port 4318
- `npm run test:browser`: desktop/mobile Chromium fixture flows, after browser installation and build
- `npm start`: serve the built app and API on 127.0.0.1:4318

Run build before start, and run all commands from the root. Desktop/mobile Chromium checks cover core flows, keyboard basics, repeated actions and API recovery. See [browser coverage and limits](docs/browser-testing.md) and remaining [manual checks](docs/testing.md).

## What is included

- Responsive Overview, Inventory, System and Activity views; explicitly planned Connections and DNS screens
- Empty/error/loading states; saved fixture selection in browser localStorage
- Stable internal asset IDs, source-scoped identity, immutable observation history, address-reuse warnings
- Evidence source, vantage, observation/receipt times, freshness, and separate current-health interpretation
- Healthy, unhealthy, stopped, unknown and stale examples; synthetic failed NFS with healthy ping/SMB
- One bounded job at a time: explicit fixture scope/exclusions, progress, idempotency keys, cancellation, total/per-target deadlines
- Initial one-pass and live periodic-fixture modes; partial results and restart recovery
- SQLite persistence; a bounded adapter interface with no device-changing operations
- One killable built-in worker per target; fixed mocked Proxmox version/node/guest operations, parent-validated batches and retained partial evidence
- Automated test source for identity, freshness, API validation, job lifecycle and persistence

## Boundaries and limits

The API binds only to 127.0.0.1. It has Host/Origin checks and a custom local-client header for mutations, but **no user authentication**. Do not expose it through a public/LAN proxy, tunnel, container port mapping, or shared host. Those guards do not protect against malicious local processes. Mobile layouts can be inspected using desktop responsive emulation; remote phone access is not enabled.

Only trusted synthetic collectors are compiled in. The optional “Simulated Proxmox inventory” target models one installation using an exact synthetic 8.4.22 profile. It never contacts a platform. Running/online states remain unknown service health, and empty permission-filtered lists never erase prior assets. See [collector boundaries](docs/collector-isolation.md).

Each target runs through a fixed Node worker with deadlines, termination, empty environment and no inherited preloads. This isolates trusted-code hangs, not hostile code or OS capabilities; Node resource limits exclude ArrayBuffers and global out-of-memory failures. No real transport, plugin loader or credential surface is provided.

Storage is capped at 200 jobs and 10,000 observations. It does not silently delete historical evidence. When capacity is reached, collection fails with retained prior data. Each System response includes at most the latest 100 observations. No automatic retention, export, encrypted database, cross-source identity reconciliation, dependency graph or migration beyond schema v1 is provided.

Database: `data/neo.sqlite` by default; an explicit `NEO_DB_PATH` environment variable may choose another local path. Stop Neo before backup/reset. Preserve the data directory (including SQLite sidecars, if present); to reset the synthetic demo, move that directory aside and restart. Do not reuse this fixture database for real inventory. There are no stored credentials or telemetry. Core operation needs no cloud service after package installation and build.

## Next milestones

1. Extend accessibility, physical-device, cross-browser and local-platform verification.
2. Review isolation and permission/version contracts before introducing any real transport.
3. Design explicitly approved scopes and real UniFi / OPNsense / Proxmox adapters with secure credential handling.
4. Build evidence-backed dependencies, guarded DNS diagnostics and resumable recommendations that show executive-function burden.
5. Assess QNAP / Nextcloud compatibility and optional endpoint-agent design.

See [architecture and collector design](docs/architecture.md) and [verification checklist](docs/testing.md). The included CI workflow checks locked installation, types, synthetic tests, build and loopback production smoke behavior. No merge, deployment or real discovery is implied by this source publication.
