# Verification checklist

## Current status

**Passed in GitHub Actions:** dependency installation, server/browser typechecks, all 13 synthetic tests, and server/browser production build.

[Verified run 38331197087](https://github.com/norgan/neo-thc/actions/runs/38331197087), 13 October 2026, source head 1de403e03643f45bff64223fb4a73ed273e93bff. GitHub tested PR merge ref fe14e5c2ece5e5c955b6db06a791e459455781e6 against main 47439e3. Environment: Ubuntu 24.04.5, Node 24.21.0, npm 11.19.0. Tests: 13 passed, 0 failed/skipped. Build: Vite 7.3.7, 28 modules, emitted HTML/JS/CSS.

The install audited 77 resolved packages and reported 0 vulnerabilities. A separate npm audit command was not run. npm also warned about two esbuild install scripts lacking allowScripts entries; typechecks, tests and build still succeeded. No broad install-script approval was added.

**Still UNRUN:** production app startup, browser/UI/accessibility checks, real device integrations, real scans and deployment. This recorded run precedes the final strengthening of the storage-failure assertion; use the current PR checks to verify the latest head.

Source was authored and published through the GitHub connector. No local executor or Work task was used. The owner explicitly requested GitHub Actions execution. CI has read-only repository permission, no configured repository-secret references, and performs only fixture checks. Source inspection and automated tests do not replace browser verification.

## First local verification

Use Node 24.x from the repository root:

```sh
node --version
npm install
npm run typecheck
npm test
npm run build
npm audit
npm start
```

The shorter aggregate `npm run check` runs typecheck, tests and build only; it does not include package audit or browser checks. It is normal for Node 24 to print an experimental SQLite warning.

The first install generates package-lock.json. Inspect it and commit the real generated lockfile after the checks pass. Do not substitute a handcrafted lockfile or claim reproducibility before it exists. Inspect audit results and changes required to remediate them before updating pinned dependencies.

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
