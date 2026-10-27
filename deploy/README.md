# Deploy the NEO collector on another computer

This bundle is the API, SQLite storage and scoped discovery service. Your NEO desktop app serves its own front end and connects directly to this service over authenticated TLS. There is no hosted control plane, cloud upload, arbitrary command endpoint or automatic discovery. Service credentials allow all of this single collector's existing diagnostic/discovery operations; this release is for a household administrator, not a multi-user permissions system.

## Minimal setup

1. Install Node **24.x** on the server and extract this bundle into a dedicated folder. Run `npm ci --omit=dev --ignore-scripts --no-fund` there.
2. Create a private directory for configuration and a writable data directory. Run under a dedicated unprivileged account. Restrict the config, token and TLS private key to that account. Keep backups of the database; stop NEO before copying it.
3. Obtain a TLS certificate for the server name and matching private key. For a private CA, select its public CA certificate in desktop Connection. Certificate names, chain and validity remain verified; self-signed exceptions and `rejectUnauthorized=false` are unavailable.
4. Create an access token using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and save it in the protected token file. Do not put it in a URL, command argument, source control or screenshots. Share it only with authorized desktop users. Rotation means replacing it and restarting the service; old tokens immediately stop working after restart.
5. Copy `deploy/service.config.example.json` to your protected config directory. Replace every example path, listen IP and HTTPS origin. A listen IP is required explicitly. The origin must match the certificate and the desktop connection URL. Relative file paths resolve from the service working directory; absolute paths are recommended.
6. Set `NEO_SERVICE_CONFIG` to that JSON file and run `npm run start:service`. On Windows, use `$env:NEO_SERVICE_CONFIG='C:\NEO\private\service.json'`. On Linux use `NEO_SERVICE_CONFIG=/etc/neo-thc/service.json npm run start:service`.
7. In desktop NEO → Settings → Desktop connection, select remote mode, enter the HTTPS origin and access token, and optionally select the issuing private CA. It verifies the server before changing modes. Remember is optional and requires protected OS credential storage. Without it, the next launch is standalone.

No real deployment, firewall rule, account creation or certificate enrollment is performed by this bundle. Limit listener access using your existing private LAN/VPN and firewall. Do not publish the service to the public Internet. The service deliberately has no browser login/CORS relaxation: the desktop's local front end holds the token outside its renderer and proxies only fixed API routes.

## Linux service and container options

`deploy/neo-thc.service` is a systemd template for `/opt/neo-thc`, `/etc/neo-thc` and `/var/lib/neo-thc`, using a pre-created `neo-thc` account. Review paths, ownership and Node location before installing it. CAP_NET_RAW permits ping; it does not grant arbitrary shell operations through NEO. Linux Wi-Fi telemetry is currently unavailable; the desktop playback computer's Windows telemetry remains available.

`docker build -f deploy/Dockerfile -t neo-thc:0.2.1 .` creates the Linux service image from this compiled bundle. Mount configuration read-only and data writable for the `node` user. Linux host networking is needed for host LAN interfaces and link-local discovery; a bridge sees the container network instead. Host networking also makes the explicitly configured listener reachable on the host. Review that placement and access before starting it. No ports are published by default. Systemd and Docker templates are provided; a real second host and container deployment still need acceptance in your environment.

## Placement and failure behavior

DNS benchmarking is optional. Windows service bundles built with this change include checksum-verified dns-bench 0.14.0. Linux/macOS services need the pinned native executable on the service account's PATH or an absolute `NEO_DNS_BENCH_PATH`; the Docker recipe does not install it automatically. [Setup and benchmark boundaries](../docs/dns-benchmark.md). In remote mode all system-resolver discovery and benchmark measurements belong to the selected server, including IPv6 interface scopes. A missing executable leaves the other diagnostics available.

- Discovery interfaces, DNS/Internet checks, inventory and report storage belong to the **server**.
- Actual playback capture belongs to the **browser/device playing the video**. The browser companion exports a minimized report for explicit import. Import in remote mode sends that report to your selected server, where up to 200 reports are retained.
- Desktop CPU/memory/Wi-Fi checks belong to the **desktop computer**, including in remote mode. They do not measure a TV, phone or remote browser.
- The desktop shows the selected collector. A lost connection yields unavailable/stale evidence; it does not silently switch to local discovery or replay failed mutations. Locally started work is stopped when changing modes. Remote jobs remain owned by the server and can be cancelled after reconnecting.
- Every scan still validates scope at the collector and requires a new explicit review and Start. Native OS probes remain bounded and read-only.
- SQLite schema **3** adds playback reports transactionally and preserves prior inventory, jobs and stats. Older application versions refuse a newer schema; restore a pre-upgrade backup to roll back.

Remote transport retains a 64 KiB request and 4 MiB response cap, strict certificate validation, no redirects, fixed API paths and bounded cancellable requests. A collector with larger snapshots may hit the response cap; existing evidence remains on that server. Authentication is one shared administrative token per collector. Rate limiting, multi-user roles, remote hosted UI and an outbound site-to-cloud channel are outside this release.

IPv4/IPv6 literal server origins use Node's native X509 IP SAN matcher; DNS names use its standard hostname matcher. Chain validation stays enabled. This avoids the [Node 24 IPv6 identity regression](https://github.com/nodejs/node/issues/64144) without accepting mismatched certificates or CN-only IP identities. Real isolated TLS tests cover IPv6 success and mismatched-IP rejection before application requests.
