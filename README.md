# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first companion for understanding a home network and homelab through one responsive desktop and mobile web interface.

## Status: opt-in IPv4 discovery milestone

This branch contains a TypeScript / Fastify / SQLite / React foundation. **The runtime baseline passed 27 unit tests, 12 desktop/mobile Chromium cases, typechecks, production build and startup smoke** on 13 October 2026 ([recorded run](https://github.com/norgan/neo-thc/actions/runs/38334947206), source head 60c860e). That smoke includes the real compiled worker. Read current PR checks for subsequent documentation revisions. Physical-device QA, comprehensive accessibility review, real integrations and deployment remain unverified.

The **Discovery** screen now implements bounded real IPv4 network requests, inactive until you choose an interface, CIDR and methods, preview the budget and confirm Start. Methods: TCP connect probes, explicit-resolver reverse DNS, mDNS service-type multicast, SSDP root-device multicast and a limited legacy NetBIOS browse-master broadcast. [Discovery scope and limits](docs/discovery.md) distinguish those mechanisms and their coverage.

Fixtures remain available in Overview. Initial/live fixture actions still send no network traffic; synthetic entries are labelled separately from real address candidates. Discovery is initial-only. There is no ping, ARP scan, IPv6 discovery, credential attempt, real Proxmox API connection or automatic scan.

This milestone's source adds transport/parser/scope tests and browser confirmation checks. Read current PR checks for its actual execution result; the earlier passing runtime baseline above does not by itself validate this new code. No user network has been scanned during development.

The [requirements](docs/requirements.md) retain the original product scope and now include the owner-approved deployment direction below. They describe the wider product, including features still planned.

## Product direction: agentless first, two deployment modes

Prefer agentless APIs and read-only protocols. Endpoint agents are optional, only for required capabilities unavailable agentlessly. A site collector may be installed alongside the UI, or remain on-premises while the interface is hosted remotely.

**Only the colocated, loopback-only application is implemented today.** Split deployment is planned. Remote static UI hosting does not decide where the API, storage or control plane runs and does not authorize inventory uploads. Managed-system credentials stay local to the collector. Pairing, authenticated encrypted outbound communication, local scope enforcement, revocation and offline delivery need design and security review before implementation. See the [deployment decision record](docs/deployment-modes.md).

## Quick start

Prerequisite: **Node.js 24.x** with npm. The engine intentionally excludes other Node majors. SQLite uses built-in `node:sqlite` (experimental/active-development in Node 24); no SQLite native addon is needed.

From the repository root:

```sh
npm ci
npm run check
npm start
```

Then open **http://127.0.0.1:4318**. Overview contains synthetic fixtures. For real network requests, open Discovery, select and preview an authorized local IPv4 scope, then confirm Start. Nothing scans automatically. Use Inventory / System for candidate evidence and Activity for progress or cancellation.

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
- `npm test`: Node test runner via tsx; isolated databases, API injection, loopback TCP/DNS fixtures and injected multicast/broadcast sockets; no user-network scans
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
- Separate explicit-scope Discovery screen with up to 256 IPv4 addresses, 1,024 TCP attempts, 256 PTR queries and one datagram per selected link-wide protocol
- Real address candidates remain job-scoped, with unknown health and explicit unverified DNS/advertisement evidence
- Automated test source for identity, freshness, API validation, job lifecycle, packet parsing, source binding and persistence

## Boundaries and limits

The API binds only to 127.0.0.1. It has Host/Origin checks and a custom local-client header for mutations, but **no user authentication**. Do not expose it through a public/LAN proxy, tunnel, container port mapping, or shared host. Those guards do not protect against malicious local processes. Mobile layouts can be inspected using desktop responsive emulation; remote phone access is not enabled.

Only fixed trusted built-in collectors are compiled in. The optional “Simulated Proxmox inventory” target models one installation using an exact synthetic 8.4.22 profile. It never contacts a platform. Running/online states remain unknown service health, and empty permission-filtered lists never erase prior assets. See [collector boundaries](docs/collector-isolation.md).

Each target runs through a fixed Node worker with deadlines, termination, empty environment and no inherited preloads. This isolates trusted-code hangs, not hostile code or OS capabilities; Node resource limits exclude ArrayBuffers and global out-of-memory failures. The discovery worker uses bounded Node TCP, DNS and UDP sockets. No dynamic plugin loader or credential surface is provided.

Storage is capped at 200 jobs and 10,000 observations. It does not silently delete historical evidence. When capacity is reached, collection fails with retained prior data. Each System response includes at most the latest 100 observations. No automatic retention, export, encrypted database, cross-source identity reconciliation, dependency graph or migration beyond schema v1 is provided.

Database: `data/neo.sqlite` by default; an explicit `NEO_DB_PATH` environment variable may choose another local path. Stop Neo before backup/reset. Preserve the data directory (including SQLite sidecars, if present); to reset the synthetic demo, move that directory aside and restart. Use a separate local database path when moving from fixture exploration to real discovery if you want to keep the inventories apart. Real addresses, PTR names and advertisements are private network metadata; protect the local database and backups. There are no stored credentials or telemetry. Core operation needs no cloud service after package installation and build.

## Next milestones

1. Extend accessibility, physical-device, cross-browser and local-platform verification.
2. Review isolation and permission/version contracts before introducing any real transport.
3. Design explicitly approved scopes and agentless UniFi / OPNsense / Proxmox adapters with local credential handling.
4. Build evidence-backed dependencies, guarded DNS diagnostics and resumable recommendations that show executive-function burden.
5. Assess QNAP / Nextcloud compatibility and optional endpoint agents only for remaining agentless capability gaps.
6. Resolve split-mode API/storage/control-plane placement and review the collector trust boundary before implementing remote hosting.

See [architecture and collector design](docs/architecture.md) and [verification checklist](docs/testing.md). The included CI workflow checks locked installation, types, synthetic tests, build and loopback production smoke behavior. No merge, deployment or real discovery is implied by this source publication.
