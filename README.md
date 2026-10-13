# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first, agentless network discovery app. The normal runtime contains no demo controls, sample devices or simulated platform integration. The opening screen is Discovery.

## Start or update locally

Requires **Node.js 24.x**. From a clean checkout on feat/initial-foundation, stop the old process with Ctrl+C before updating:

```powershell
git pull --ff-only origin feat/initial-foundation
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Open **http://127.0.0.1:4318**. The header should show **real-discovery-v2**. If you see an older demo interface, stop the old server, rebuild, restart and reload. A new frontend detects an older API and explains the mismatch.

On macOS/Linux, use npm instead of npm.cmd. Build/start commands are portable by source inspection; Windows itself has not been executed in CI. The standalone smoke/browser process harnesses target Linux.

Build cleans only generated dist/server files; it never touches data. SQLite remains schema v1. **Do not wipe your database:** real discovery results are preserved. Legacy synthetic rows remain stored but are excluded from normal inventory, evidence, activity, ambiguity warnings and collection capacity. There is no public fixture submission endpoint.

## Real discovery

1. Choose the source interface. Its actual CIDR is prefilled and editable.
2. Select methods. TCP ports are fully visible in a multiline field; target × unique-port counts show the exact attempt budget.
3. For PTR DNS, Neo reads local system configuration without sending a query. On Windows it uses a fixed, read-only Get-DnsClientServerAddress command to find interface-specific IPv4 resolvers. Other systems, or an unavailable Windows read, use a clearly labelled system-wide configuration list. Only an on-link supported resolver is prefilled; no gateway or public DNS address is guessed. You can edit the choice.
4. Preview the scope, review the budget, confirm, then Start. Prefill and preview do not scan.
5. Activity shows progress, cancellation and per-method outcomes. Inventory contains address candidates and evidence, not a claimed count of verified devices.

Methods: numeric IPv4 TCP connect probes; reverse DNS/PTR; mDNS service-type multicast; SSDP root-device multicast; limited legacy NetBIOS browse-master broadcast. No ping/ARP, IPv6, UDP port sweep, banner capture, URL fetching, credential attempt or automatic scheduled scan.

At most 256 IPv4 addresses, eight selected ports and 1,024 total TCP attempts; one pass with a 60-second bound. Multicast/broadcast require separate full-subnet approval on an unambiguous /24–/30 interface. The whole link receives those queries. See [exact protocol scope and limits](docs/discovery.md).

A run may finish **completed with issues** when individual methods encounter a denied socket, unavailable source, DNS timeout/refusal or receive cap. Saved evidence remains available. Expected TCP refusal/timeout, DNS no-data and silent advertisements are inconclusive outcomes, not proof of failure or absence. Older jobs retain their existing generic errors because discarded method diagnostics cannot be reconstructed.

## Safety and data

The UI/API binds to 127.0.0.1 only. Host/Origin/client-header guards are present, but there is no user authentication. Do not expose it through a LAN/public proxy, tunnel or container mapping.

Data is stored locally in data/neo.sqlite, or an explicit local NEO_DB_PATH. Stop Neo before backup; preserve SQLite sidecars if present. Network addresses, DNS names and advertisements are private metadata. Neo does not upload them. No credentials are required for these discovery methods.

Identity remains source/job/address-scoped; IP/MAC claims never merge devices permanently. Health remains unknown; timestamps, expiry and unverified claims are visible. Node workers isolate trusted-code hangs, not hostile code or OS capabilities. Storage is bounded to 200 visible jobs and 10,000 visible observations; legacy samples do not consume the real-data allowance.

## Development and verification

```sh
npm ci
npm run check
npm start
```

Use npm run dev:api and npm run dev:web in separate terminals for development (Vite: 127.0.0.1:5173). npm run check runs typechecks, unit tests and build. npm run smoke exercises actual compiled discovery sockets against an isolated loopback listener; npm run test:browser exercises the production UI with controlled API data. Browser installation is documented in [browser testing](docs/browser-testing.md).

Fixtures exist only in tests/support and are excluded from the production build. They are injected explicitly by tests, never selected by an environment variable or production HTTP request. The production worker contains only real network operations.

The real-only correction at 7002b4a passed 50 unit tests, 16 desktop/mobile Chromium cases, typechecks, build and actual compiled-worker loopback smoke ([run](https://github.com/norgan/neo-thc/actions/runs/38344284713)). Review follow-ups add live System freshness and direct socket/resolver diagnostic regressions (51 unit tests in source); **current PR checks are the source of truth for the final head**. Source is authored through chat/GitHub and executed by authorized GitHub Actions, without local repository execution. Physical network interoperability, Windows execution, Safari/Firefox and full accessibility remain unverified. A user-reported local Windows scan saved candidate evidence but reported a generic method issue on the prior build; that is not a claim that all protocols succeeded.

## Product direction

Agentless first. An optional endpoint agent is only for capabilities unavailable agentlessly. Colocated UI/collector is implemented; an on-premises collector with remotely hosted interface is planned. Remote UI does not decide API/storage/control-plane location or authorize uploading inventory. Local secrets, authenticated encrypted pairing, scope enforcement, revocation and offline delivery require design/security review. See [deployment modes](docs/deployment-modes.md) and [requirements](docs/requirements.md).

Real Proxmox and other credentialed platform adapters, dependency graphs, advanced DNS diagnostics, recommendations and remote deployment remain planned. No merge or deployment is implied.
