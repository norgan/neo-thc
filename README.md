# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first companion for understanding a home network and homelab through one responsive desktop and mobile web interface.

## Status: fixture foundation with passing automated checks

This branch contains an initial TypeScript / Fastify / SQLite / React implementation. **GitHub Actions passed installation, typechecks, all 13 synthetic tests, production build, and a production-startup smoke check** on 13 October 2026 ([recorded run](https://github.com/norgan/neo-thc/actions/runs/38331806414), source head 48beb6b). The smoke check covers npm start, loopback health, built HTML/JS/CSS, initial fixture collection, inventory and graceful shutdown. See current PR checks for later commits. Browser QA and deployment remain UNRUN. Treat this as a testable foundation, not a verified end-to-end release.

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
- `npm start`: serve the built app and API on 127.0.0.1:4318

Run build before start, and run all commands from the root. UI layout, keyboard behavior and repeated interactions still need the [manual checks](docs/testing.md).

## What is included

- Responsive Overview, Inventory, System and Activity views; explicitly planned Connections and DNS screens
- Empty/error/loading states; saved fixture selection in browser localStorage
- Stable internal asset IDs, source-scoped identity, immutable observation history, address-reuse warnings
- Evidence source, vantage, observation/receipt times, freshness, and separate current-health interpretation
- Healthy, unhealthy, stopped, unknown and stale examples; synthetic failed NFS with healthy ping/SMB
- One bounded job at a time: explicit fixture scope/exclusions, progress, idempotency keys, cancellation, total/per-target deadlines
- Initial one-pass and live periodic-fixture modes; partial results and restart recovery
- SQLite persistence; an in-process adapter interface with no device-changing operations
- Automated test source for identity, freshness, API validation, job lifecycle and persistence

## Boundaries and limits

The API binds only to 127.0.0.1. It has Host/Origin checks and a custom local-client header for mutations, but **no user authentication**. Do not expose it through a public/LAN proxy, tunnel, container port mapping, or shared host. Those guards do not protect against malicious local processes. Mobile layouts can be inspected using desktop responsive emulation; remote phone access is not enabled.

One trusted, synthetic adapter is compiled in. Async timeouts ignore late results, but this is **not** worker/process isolation and cannot interrupt a CPU-blocking adapter. No real adapter may be enabled before isolation, runtime result validation, permission checks, secret handling and operation allowlists are implemented.

Storage is capped at 200 jobs and 10,000 observations. It does not silently delete historical evidence. When capacity is reached, collection fails with retained prior data. Each System response includes at most the latest 100 observations. No automatic retention, export, encrypted database, cross-source identity reconciliation, dependency graph or migration beyond schema v1 is provided.

Database: `data/neo.sqlite` by default; an explicit `NEO_DB_PATH` environment variable may choose another local path. Stop Neo before backup/reset. Preserve the data directory (including SQLite sidecars, if present); to reset the synthetic demo, move that directory aside and restart. Do not reuse this fixture database for real inventory. There are no stored credentials or telemetry. Core operation needs no cloud service after package installation and build.

## Next milestones

1. Complete browser, accessibility and local-platform checks. CI installation reported zero known vulnerabilities for its resolved dependency set; this is not a security guarantee.
2. Add isolated collectors, runtime result schemas and version-aware read-only adapter allowlists.
3. Implement explicitly approved scopes and first UniFi / OPNsense / Proxmox adapters.
4. Build evidence-backed dependencies, guarded DNS diagnostics and resumable recommendations that show executive-function burden.
5. Assess QNAP / Nextcloud compatibility and optional endpoint-agent design.

See [architecture and collector design](docs/architecture.md) and [verification checklist](docs/testing.md). The included CI workflow checks locked installation, types, synthetic tests, build and loopback production smoke behavior. No merge, deployment or real discovery is implied by this source publication.
