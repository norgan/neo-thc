# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first home tech support platform: understand the home network, investigate slow Internet and streaming, collect evidence, and get a practical next step. Discovery supplies part of that evidence. The network operations centre (NOC) opens with saved systems, service evidence and reported capacity; **Diagnostics** offers guided Internet/streaming and targeted DNS/IPv4/IPv6/TLS checks. Use **Add or rescan systems** for inventory. The normal runtime contains no demo controls, sample devices or simulated platform integration.

## Desktop app and a collector on another computer

Version **0.2.1**, runtime **playback-desktop-v7**, adds actual browser playback reports and a self-contained Windows desktop app. Run the portable executable, or use the per-user installer; no separate Node installation is needed for the desktop. Standalone starts its own loopback API, collector and SQLite database in the OS application-data folder. Closing it stops its local collector.

In **Settings → Desktop connection**, choose standalone or an authenticated HTTPS collector service. Remote mode keeps packaged UI assets and CPU/memory/Wi-Fi reads on the desktop, while discovery, Internet diagnostics and report storage run on the selected server. Its token stays outside the web renderer; optional remembered tokens require protected OS storage. Connection changes never start discovery. [Server deployment instructions](deploy/README.md) and [placement/trust boundaries](docs/deployment-modes.md).

The interface defaults to **dark mode** using NableU’s navy surfaces, blue accents and control styling, including forms, discovery dialogs, playback reports and status messages. Use the header theme button or **Settings → Appearance** to choose dark or light; the choice is stored on this device. If browser storage is unavailable, theme changes still work for the current session. Desktop startup and the connection window use dark backgrounds. [Styling reference](docs/style-reference.md).

**Playback** imports measurements from the included user-activated Edge/Chrome companion: decoded resolution and changes, buffer ahead, rebuffer waiting time, stalled events, dropped-frame deltas and page long tasks. It uses the existing playing browser and does not collect account data, cookies, titles, media URLs or video. Review before saving to the selected collector. [One-time companion setup](docs/playback-setup.html) · [Measurement interpretation](docs/playback.md). The companion is supplied as unpacked source, not a store-published extension. Installation is an explicit browser-owner step.

From source, use `npm run build`, `npm run desktop`, `npm run package:desktop` and `npm run package:service`. Release files are generated under `release/`; they are not source-controlled. Desktop Windows x64 is the packaged target; other desktop platforms require their own build and acceptance. Desktop packages are currently unsigned.

## Start or update the local browser version

Requires **Node.js 24.x**. From a clean checkout on feat/initial-foundation, stop the old process with Ctrl+C before updating:

```powershell
git pull --ff-only origin feat/initial-foundation
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Open **http://127.0.0.1:4318**. The header should show **playback-desktop-v7**. If you see an older interface, stop the old server, rebuild, restart and reload. A new frontend detects an older API and explains the mismatch. Stop this browser server before launching the desktop app: both use port 4318.

On macOS/Linux, use npm instead of npm.cmd. Node 24 unit tests, typechecks and build are also checked locally on Windows during this continuation. The standalone process-group smoke harness targets Linux; physical network and Glances compatibility require separate verification.

Build cleans only generated dist/server files; it never touches data. SQLite upgrades transactionally to schema **3**, adding bounded playback history while preserving existing inventory/jobs/stats. **Stop Neo and back up your database before updating:** older builds refuse schema 3; roll back using the pre-upgrade backup. See [Windows backup and rollback](docs/glances.md#windows-update-and-database-backup). Legacy synthetic rows remain stored but are excluded from normal inventory, evidence, activity, ambiguity warnings and collection capacity. There is no public fixture submission endpoint.

## Real discovery

1. Open **Add or rescan systems** and choose the source interface. Its actual CIDR is prefilled and editable. Closing discovery preserves edits and clears consent.
2. Select methods. TCP offers a visible 48-port common homelab profile and an editable custom list. Target × unique-port counts, concurrency and the selected deadline show the exact attempt budget; scope is never silently reduced to fit.
3. For PTR DNS, Neo reads local system configuration without sending a query. On Windows it uses a fixed, read-only Get-DnsClientServerAddress command to find interface-specific IPv4 resolvers. Other systems, or an unavailable Windows read, use a clearly labelled system-wide configuration list. Only an on-link supported resolver is prefilled; no gateway or public DNS address is guessed. You can edit the choice.
4. Optionally enable **Read existing Glances REST stats automatically**, choose HTTP or verified HTTPS, and approve link-wide discovery. This resolves at most two advertised REST endpoints inside the approved scope and reads their fixed stats paths after discovery. It does not install Glances or request credentials.
5. Preview the scope, review all network operations and budgets, confirm, then Start. Prefill and preview do not scan.
6. Activity shows progress, cancellation and per-method outcomes, including optional Glances enrichment. Systems prioritizes names, services and useful responses. All address attempts and raw evidence remain available; address views are not permanent verified-device identities.

Methods: numeric IPv4 TCP connect probes; reverse DNS/PTR; mDNS service-type multicast; SSDP root-device multicast; limited legacy NetBIOS browse-master broadcast. No ping/ARP, IPv6, UDP port sweep, banner capture, URL fetching, credential attempt or automatic scheduled scan.

At most 256 IPv4 addresses, 64 selected ports and 16,384 TCP attempts. Reviewable concurrency choices are 8, 16 or 32; whole-job deadlines are 1, 2, 4 or 8 minutes, with four minutes selected initially. TCP starts are paced to at most 100 per second. Multicast/broadcast and automatic Glances resolution require separate full-subnet approval on an unambiguous /24–/30 interface. The whole link receives those queries. See [exact protocol scope and limits](docs/discovery.md).

A run may finish **completed with issues** when individual methods encounter a denied socket, unavailable source, DNS timeout/refusal or receive cap. Saved evidence remains available. Expected TCP refusal/timeout, DNS no-data and silent advertisements are inconclusive outcomes, not proof of failure or absence. Older jobs retain their existing generic errors because discarded method diagnostics cannot be reconstructed.

## Diagnose Internet, streaming, DNS and IPv4/IPv6 connections

Open **Diagnostics → Home Internet and streaming** for a guided YouTube/Netflix DNS check, gateway versus Internet ping samples, IPv4 path MTU and local MTU/DHCP/DNS-suffix/gateway configuration. An optional download of at most 8 MiB from Cloudflare estimates streaming capacity against published guidance. The exact recipients, targets, data budget and 45-second limit are shown before approval. Results are snapshots from the collector; playback resolution, dropped frames, DRM and sustained video-CDN quality are not inferred.

For a specific name, enter its full hostname or choose **YouTube DNS / Netflix DNS**. Select configured resolvers and their DNS port (53 normally; a selected custom port can test Unbound or another fallback). Neo records A/AAAA answers, TTLs, timings and distinct errors, with optional OS resolution labelled separately. Missing AAAA explains why ping -6 can fail while IPv4 works; NXDOMAIN remains distinct. Select exact returned IPv4/IPv6 addresses to separately approve TCP and certificate-verified TLS on one service port.

Saved diagnoses show partial results, findings and a clear next step. Repeat during an intermittent stall and compare recent timing. Diagnosis changes no network settings. See [home support diagnosis](docs/diagnostics.md) for scope and interpretation. The inventory scanner remains IPv4-only; targeted IPv6 DNS and connection checks are implemented separately.

**DNS benchmark: system resolvers and IPv6** adds pinned `dns-bench` 0.14.0. It compares configured system DNS and explicit public candidates across IPv4/IPv6 resolver transport, A/AAAA questions and UDP/TCP, with repeated measurements, reliability-first summaries and saved partial results. NEO reads system DNS itself and supplies it explicitly, avoiding upstream's IPv6-first Windows discovery bug. New Windows packages bundle the checksum-verified engine; source checkouts use `npm run setup:dns-bench`. See [DNS benchmark setup, scope and interpretation](docs/dns-benchmark.md). A benchmark winner describes the successful selected tests; filtering, local names, encrypted DNS and application behaviour need their own evidence.

## Safety and data

The normal browser and desktop front ends bind to 127.0.0.1 only. Their Host/Origin/client-header guards are local browser defenses, not user authentication. The separate opt-in `start:service` entry point requires an explicit listen address, exact HTTPS origin, valid certificate/key and a strong administrative token. Do not expose the local entry point or publish the service to the public Internet. Use the reviewed private LAN/VPN path described in [deployment](deploy/README.md).

The browser version stores data in data/neo.sqlite or an explicit NEO_DB_PATH; desktop standalone uses its OS application-data folder; remote mode stores reports and inventory on the selected server. Stop Neo before backup; preserve SQLite sidecars if present. Network addresses, DNS names, settings and advertisements are private metadata. Importing playback in remote mode sends that minimized report to the selected server. Approved DNS recipients receive queried names; public Internet checks expose the collector's source IP to their listed recipients. Video-account credentials are never collected.

Identity remains source/job/address-scoped; IP/MAC claims never merge devices permanently. Health remains unknown; timestamps, expiry and unverified claims are visible. Node workers isolate trusted-code hangs, not hostile code or OS capabilities. Storage is bounded to 200 visible jobs and 10,000 visible observations; legacy samples do not consume the real-data allowance.

## Development and verification

```sh
npm ci
npm run check
npm start
```

Use npm run dev:api and npm run dev:web in separate terminals for development (Vite: 127.0.0.1:5173). npm run check runs typechecks, unit tests and build. npm run smoke exercises actual compiled discovery sockets against an isolated loopback listener; npm run test:browser exercises the production UI with controlled API data. Browser installation is documented in [browser testing](docs/browser-testing.md).

Fixtures exist only in tests/support and are excluded from the production build. They are injected explicitly by tests, never selected by an environment variable or production HTTP request. The production worker contains only real network operations.

The 14 October continuation adds shutdown regressions for unused browser connections, incomplete HTTP requests and an active stats read. The server cancels collection before HTTP draining, preserves completed stats sections, then closes remaining local connections before SQLite. All 74 unit tests passed locally on Windows with Node 24.19.0, including real isolated loopback transports and TLS rejection. **Current [PR checks](https://github.com/norgan/neo-thc/pull/1/checks) are the source of truth for the published head**, including Linux process shutdown and desktop/mobile browser cases. See [verification](docs/testing.md). Physical network interoperability, Safari/Firefox and full accessibility remain unverified.

## Product direction

Agentless first. An optional endpoint agent is only for capabilities unavailable agentlessly. Colocated UI/collector is implemented; an on-premises collector with remotely hosted interface is planned. Remote UI does not decide API/storage/control-plane location or authorize uploading inventory. Local secrets, authenticated encrypted pairing, scope enforcement, revocation and offline delivery require design/security review. See [deployment modes](docs/deployment-modes.md) and [requirements](docs/requirements.md).

Further home support includes device-specific troubleshooting, richer incident correlation, playback evidence and reviewed repair workflows. Credentialed platform adapters, dependency graphs and remote deployment remain planned. Implemented diagnoses and these planned capabilities are separate; no merge or deployment is implied.


## Systems and real stats (home-support-v6)

The NOC and Systems views show friendly PTR names, advertised services and evidence-supported role suggestions. Search names/services/roles; enable “Show all address attempts” for silent or DNS-only candidates. The Network view separates scanned scopes, unclassified infrastructure candidates and delivered-service evidence. Address/interface grouping is presentation only: original job-scoped identities, observations and past names stay separate. Only the newest address observation supplies current name and service suggestions.

Choose **Inspect system → Connect system stats** for a real, one-shot Glances REST API v4 read. Review the exact IP, scheme, port and six fixed GET paths, then approve it. CPU, memory, uptime and per-mount filesystem capacity are reported values with timestamps and partial errors. The default port 61208 is a suggestion, not a discovered port. Authentication-required endpoints stop without credential attempts. No integration installation, recurring polling or credential setup is performed. See [Glances scope and setup](docs/glances.md).

Glances introduced the schema-v2 stats-history table. The current playback release advances to schema 3 while retaining discovery, stats and quarantined legacy data. Back up SQLite while Neo is stopped; restore the pre-upgrade backup to roll back an older binary. No data wipe is needed.
