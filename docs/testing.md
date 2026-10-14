# Current verification: network-overview-v4

Continuation on 14 October 2026, starting from PR #1 head ecb6f17. That head's [run 38350707373](https://github.com/norgan/neo-thc/actions/runs/38350707373) passed typechecks, 72 unit tests, build and compiled loopback smoke, but failed two desktop browser teardowns because the server required SIGKILL. Its PR description still cited an older passing head.

The continuation cancels collection in preClose, before pending HTTP responses drain, and closes unused/incomplete browser connections during shutdown. New regressions failed on the original code and cover unused connections, partial request headers/bodies, and an active HTTP stats read that must retain completed metrics before SQLite closes. The regressions preserve the existing 2.5-second shutdown bound rather than weakening the browser harness's five-second check.

Local Windows verification used Node 24.19.0 and npm 11.6.2:

- Locked dependency install: passed; npm reported zero vulnerabilities.
- Unit suite: **74 passed, zero failed/skipped**, including isolated real TCP, DNS, HTTP and untrusted TLS fixtures.
- Server, web and browser-test typechecks: passed.
- Production build: passed.
- Chromium desktop/mobile UI: **28 passed** in 1.3 minutes, using controlled local data. Windows process.kill does not exercise the POSIX graceful-signal path; the new app.close regression tests exercise shutdown directly.
- The Linux-only process-group smoke and graceful SIGTERM browser teardown are verified by [current PR checks](https://github.com/norgan/neo-thc/pull/1/checks), not inferred from the Windows run.

No LAN discovery, multicast/broadcast transmission, physical Glances connection, credentials, merge or deployment was performed. Physical-network interoperability, Safari/Firefox and full accessibility remain unverified. The following records preserve earlier milestones; their fixture UI descriptions and counts are historical.

## Historical real-only correction

The real-discovery-v2 correction at 7002b4a passed 50 unit tests, 16 Chromium cases, typechecks, build and the actual compiled-worker loopback smoke in [run 38344284713](https://github.com/norgan/neo-thc/actions/runs/38344284713). Review follow-ups add a System freshness poll regression and direct diagnostic transport tests (51 unit tests); current PR checks apply to the final head. Tests now cover preserved real records with non-destructively hidden legacy samples, real-only capacity/collision handling, system CIDR/DNS prefill, exact port budgets, visible form locks and structured partial outcomes. Browser cases were rewritten for the normal real-only UI. Production smoke executes the actual compiled discovery TCP worker against a loopback listener and confirms fixture POST routes are absent. No LAN scan is executed in CI. Historical verification below describes earlier code, not the current UI.

# Verification checklist

## Current status

**Passed discovery milestone in GitHub Actions:** locked installation, typechecks, 40 unit tests (0 failed), 16 desktop/mobile Chromium cases (51.1 seconds), production build and Linux startup smoke at [head 31cb874](https://github.com/norgan/neo-thc/actions/runs/38340290987), 13 October 2026. Smoke exercised compiled fixture/Proxmox and discovery workers, with discovery using its synthetic-only transport seam.

Review corrections add expiry, real/synthetic detail labels, running cancellation, partial-result retention, hard deadline, queued late-message/slot-reuse and bounded ambiguity-summary checks (46 unit tests in source). Read the current PR checks for execution at that final head; the immutable recorded run predates those corrections.

Historical foundation evidence follows:

[Verified run 38331806414](https://github.com/norgan/neo-thc/actions/runs/38331806414), 13 October 2026, source head 48beb6be37113498973eb3a9c840cc599ace6434. GitHub tested the PR merge ref against main 47439e3. Environment: Ubuntu 24.04.5, Node 24.21.0, npm 11.19.0. Tests: 13 passed, 0 failed/skipped.

The separate smoke script starts the actual `npm start` command with an isolated temporary SQLite database. It verifies loopback health; production HTML, JavaScript and CSS with expected MIME types; one initial two-target fixture job; populated synthetic inventory; and process-group shutdown with the loopback listener closed. It has a 30-second exercise deadline, per-request timeouts, bounded readiness/job polling, and a separate five-second graceful cleanup window with failure on forced shutdown. It does not execute browser JavaScript or contact devices.

Installation audited 77 resolved packages and reported 0 vulnerabilities. A separate `npm audit` command was not run. npm warned about two esbuild install scripts lacking allowScripts entries; typechecks, tests and build still succeeded. No broad install-script approval was added.

**Verification boundary:** the baseline desktop/mobile Chromium cases passed; see [browser testing](browser-testing.md) for exact coverage. Non-Linux/local-machine verification, physical devices, comprehensive accessibility review, real integrations, real scans and deployment remain unverified. Read current PR checks for the latest commit; the recorded run above is immutable evidence, not a claim about every later commit.

Source was authored and published through the GitHub connector. No local executor or Work task ran repository code. The owner requested GitHub Actions testing. CI has read-only repository permission, no configured repository-secret references, and performs only fixture/loopback checks.

## Authentic dependency lockfile

The initial lockfile provenance below describes the foundation resolution. The current lockfile was subsequently regenerated by the authorized Playwright bootstrap; see [browser testing and current lock provenance](browser-testing.md). Neither file was manually reconstructed or regenerated locally.

The initial package-lock.json came from the npm install in the successful run above.

- [Original artifact](https://github.com/norgan/neo-thc/actions/runs/38331806414/artifacts/11782753201): generated-package-lock, artifact ID 11782753201
- ZIP SHA-256: 29190f5910b6fb09572508bcc6ac3617e680f6c78f95fa781eb22957b36f0540
- Exact package-lock.json SHA-256: c5fda98e912a4a740aa866ce0c8a47933a0feec44b659a4a7218b02e51e4eba9
- JSON size: 77,773 bytes; lockfile version 3
- Archive inspection allowed exactly package-lock.json, enforced size/path bounds, and extracted only its bytes in memory.
- Verified root dependencies, devDependencies, engine and every direct pinned version match package.json. All resolved download URLs point to registry.npmjs.org.
- The file is committed byte-for-byte unchanged. CI now uses `npm ci` and preserves the tested lock as a seven-day artifact. Artifact expiry does not affect the committed copy.

The only local data-processing command read and validated this authorized CI archive using trusted standard-library ZIP/JSON tools. It did not install, build, test or execute repository code.

## Local verification commands

Use Node 24.x from the repository root:

```sh
node --version
npm ci
npm run typecheck
npm test
npm run build
npm audit
npm start
```

The shorter aggregate `npm run check` runs typecheck, tests and build only; it does not include the separate Linux-only `npm run smoke`, package audit or browser checks. It is normal for Node 24 to print an experimental SQLite warning.

Use the committed generated package-lock.json with npm ci. Dependency updates must regenerate and review the lock through an authorized execution environment. Inspect audit results and remediation changes before updating pins.

## Automated coverage

tests/foundation.test.ts uses node:test, strict assertions, Fastify injection and isolated SQLite databases. It is intended to cover:

1. IP reuse, stable internal IDs, duplicate observation delivery and retained address history
2. Fresh, stale, stopped, unhealthy and unknown interpretation
3. Scope/exclusion validation, immutable job bounds, unsupported fields and request IDs
4. Empty inventory, initial collection, exclusions, evidence API and idempotent/reused request IDs
5. Host/Origin/client-header defenses, bad requests and sanitized malformed JSON errors
6. Periodic fixture observations and natural cycle-bound completion
7. One active job, progress, cancellation, repeated cancellation and partial results
8. Whole-job timeout
9. An unresolved asynchronous adapter call, deadline isolation and later-target progress
10. Graceful shutdown and rejection of further work
11. Persistent asset identity and restart interruption recovery
12. Unknown thrown values, invalid status-code types and redacted diagnostic payloads
13. Background SQLite write failures do not reject unhandled; collection fails closed and reports incomplete state

The new tests/collector.test.ts adds fixed mock operations, version/schema gates, migration identity, permission-filtered empty/error responses, health/freshness semantics, source-mode worker startup, synchronous CPU and promise hangs, crash/early exit, forged/duplicate/late messages, cancellation, whole-job timeout, shutdown and scope exclusion checks. Production smoke also runs the emitted .mjs worker through npm start. These prove the exercised trusted-fixture boundaries. The separate discovery transport is covered below; workers are not hostile-code sandboxes.

tests/discovery.test.ts checks CIDR/interface/budget validation, fixed mDNS/NBNS/SSDP packet and bounded parser behavior, explicit resolver DNS and TCP on loopback fixtures, mocked multicast/broadcast destination/source binding, receive caps, advertised expiry and parent-owned age, real/synthetic provenance, shared-slot/idempotency controls, running-worker cancellation with retained partial data, hard deadlines and queued post-terminal messages. Test-only worker scenarios are constructor-only, unavailable through API/environment settings. No test broadcasts or multicasts on the CI network.

## Manual browser checks

Open http://127.0.0.1:4318 after build/start, or port 5173 using both development commands.

- Empty database: clear next step, zero counts, empty Inventory/Activity, no misleading healthy state.
- Initial collection: explicit fixture labels persist on every screen; six selected targets produce six assets.
- Scope/exclusions: deselected/excluded devices are not collected; all-excluded scope cannot submit.
- Identity: previous/current address holders remain separate IDs; the historical one is stale and current health unknown.
- Services: storage shows NFS unhealthy alongside healthy ping and SMB; no root cause is invented.
- Freshness: leave the app idle beyond 60 seconds. Health changes to unknown as evidence becomes stale.
- Repeated clicks: only one active job; repeated same request after a transport error is idempotent.
- Live: updates produce history; cycle and 30-second bounds stop work. Refreshing the page does not create a new job.
- Cancel twice; navigate away and back while running; verify partial data remains.
- Stop/restart API during a live run. Activity becomes interrupted, not completed, and prior evidence remains.
- UI error: stop API while viewing inventory. Stale displayed information is explicitly flagged; Retry recovers without a new collection.
- Rapidly switch selected systems; older evidence responses must not overwrite newer selection.
- Browser Back/Forward: this starter uses in-page tabs, not URL routes. Back leaves the application according to browser history; route-based history is deferred.
- Narrow 375 px viewport and desktop: no horizontal content overflow, controls usable, text legible.
- Keyboard only: all tabs, forms, details, and cancellation reachable; focus visible; status not conveyed by color alone.
- Scope selection survives reload. Storage-disabled browsing still works without preference persistence.
- Connections and advanced DNS diagnostics remain visibly planned. The simulated Proxmox inventory is labelled; Discovery alone offers explicit real IPv4 requests after preview and confirmation. No credential fields appear.
- Discovery starts with empty scope and methods; setting changes invalidate preview and confirmation. Link-wide methods disclose the entire interface subnet. Review budget, start explicitly, cancel and inspect address-candidate evidence. Physical-network execution requires a separately chosen authorized scope and remains unverified.
- Production asset paths and Content-Security-Policy allow the built JS/CSS to load.

Record actual command outputs, environment versions, browser and failures before changing any remaining UNRUN status.


## Semantic inventory and Glances extension

The new tests cover legacy evidence parsing, cautious service/role projection, responder filtering, latest-address isolation, additive schema-v2 preservation, scoped endpoint consent/idempotency, shared collection capacity and cancellation. Isolated loopback HTTP tests exercise the real transport, fixed paths, auth/version stops, response bounds, redirects, compression and absolute deadlines. Compiled smoke adds a real loopback Glances HTTP read. Browser tests add friendly system cards and explicit partial stats snapshots on desktop/mobile. The first semantic/stats head d81bf536 passed typechecks, unit tests, build, compiled TCP/Glances loopback smoke and desktop/mobile Chromium in [run 38348166890](https://github.com/norgan/neo-thc/actions/runs/38348166890). Review follow-ups add TLS certificate rejection, missing-uptime validation and stale-API stats locking; the PR records exact final-head evidence. No physical Glances endpoint is contacted by CI.
