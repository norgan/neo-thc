# Verification checklist

## Current status

**Passed in GitHub Actions:** dependency installation, server/browser typechecks, all 13 synthetic tests, server/browser production build, and Linux production-startup smoke.

[Verified run 38331806414](https://github.com/norgan/neo-thc/actions/runs/38331806414), 13 October 2026, source head 48beb6be37113498973eb3a9c840cc599ace6434. GitHub tested the PR merge ref against main 47439e3. Environment: Ubuntu 24.04.5, Node 24.21.0, npm 11.19.0. Tests: 13 passed, 0 failed/skipped.

The separate smoke script starts the actual `npm start` command with an isolated temporary SQLite database. It verifies loopback health; production HTML, JavaScript and CSS with expected MIME types; one initial two-target fixture job; populated synthetic inventory; and process-group shutdown with the loopback listener closed. It has a 30-second exercise deadline, per-request timeouts, bounded readiness/job polling, and a separate five-second graceful cleanup window with failure on forced shutdown. It does not execute browser JavaScript or contact devices.

Installation audited 77 resolved packages and reported 0 vulnerabilities. A separate `npm audit` command was not run. npm warned about two esbuild install scripts lacking allowScripts entries; typechecks, tests and build still succeeded. No broad install-script approval was added.

**Still UNRUN:** interactive browser/UI/accessibility QA, non-Linux/local-machine verification, real device integrations, real scans and deployment. Read current PR checks for the latest commit; the recorded run above is immutable evidence, not a claim about every later commit.

Source was authored and published through the GitHub connector. No local executor or Work task ran repository code. The owner requested GitHub Actions testing. CI has read-only repository permission, no configured repository-secret references, and performs only fixture/loopback checks.

## Authentic dependency lockfile

The committed package-lock.json came from the npm install in the successful run above, not from manual reconstruction or local regeneration.

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

Tests do not prove hard isolation from synchronous CPU hangs. No real adapter exists. The first CI run passed; timing checks still need observation across later environments and repeated runs.

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
- Connections and DNS remain visibly planned. No credential fields, real probes or integration claims appear.
- Production asset paths and Content-Security-Policy allow the built JS/CSS to load.

Record actual command outputs, environment versions, browser and failures before changing any remaining UNRUN status.
