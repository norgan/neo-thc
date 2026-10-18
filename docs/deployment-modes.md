# Desktop and split collector deployment

Decision updated 18 October 2026 in response to the owner's request for a desktop app and a front end connected to discovery on another computer.

## Implemented placement

1. **Standalone desktop:** packaged Electron UI plus an owned Node utility process, local SQLite and read-only collector. It listens on loopback only. Closing the desktop cancels local work, awaits shutdown and closes storage. No external Node installation is needed.
2. **Split desktop/server:** packaged UI plus a local fixed-route proxy; the explicitly selected server owns its API, SQLite, scope enforcement and discovery/Internet operations. Desktop-native CPU/memory/Wi-Fi checks stay on the desktop. Minimized browser playback reports are sent to that server only after review and Save.
3. **Local browser:** the original Node 24 loopback runtime remains useful without Electron.

The separate server entry point requires an explicit listen IP, exact HTTPS origin, certificate/key and a strong administrative bearer token. Normal local startup has no LAN bind environment switch. TLS chain, hostname and validity are checked; a selected private CA can establish trust without bypass. Tokens are passed outside the renderer, never in URLs/arguments or logged responses. Optional remembered desktop tokens use protected OS encryption; unprotected Linux basic_text storage is rejected. Without Remember, the token is session-only and the next launch is standalone.

The split implementation uses a direct desktop-to-private-server connection, selected explicitly during setup. It does not implement the earlier proposed outbound site-to-cloud channel, hosted scheduling, cloud storage or independently hosted web UI. No real listener exposure, firewall change, secret enrollment or remote deployment occurs merely by building the app.

## Authority and failure

The configured collector is the authority for interface eligibility, bounded scope, method budgets, concurrency and cancellation. A desktop can submit only existing fixed API operations. There is no arbitrary shell, command, URL-fetch, plugin or configuration execution endpoint. Every scan still requires review and Start. Managed-system credentials are not part of these collectors.

The server uses one household-administrator token with access to all of that collector's retained evidence and bounded operations. This is not a multi-tenant or role-based service. Rotate the token and restart to revoke access; existing copies cannot be recalled. Restrict the service to an approved private LAN/VPN and firewall policy; public Internet exposure is outside this release.

A disconnect shows unavailable/stale data, never a healthy/down inference. The desktop does not fall back silently to local discovery, replay mutations or claim unsaved reports were retained. Remote jobs stay owned by the server and can be cancelled after reconnection. Local jobs are stopped when switching placement. Requests and response sizes are bounded; shutdown aborts and awaits proxy/configuration work. There is no outbound spool or unbounded retry queue.

Playback capture always belongs to the browser that plays the video. A downloaded report is an imported claim, not independently attested device identity. Native desktop readings are only relevant to that capture when it came from the same computer at the same time. Server Wi-Fi cannot describe a remote TV or laptop.

See [deployment instructions and templates](../deploy/README.md) and [actual playback evidence](playback.md). Linux systemd/Docker templates and real second-host acceptance are separate from isolated TLS/proxy tests. No physical deployment is claimed by automated checks.
