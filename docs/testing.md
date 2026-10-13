# Verification checklist

## Current status

**UNRUN: every install, test, typecheck, build, security audit, application start and browser check.**

Source was authored and published through the GitHub connector. No local executor, Work task, CI workflow, real network scan, device connection or deployment was launched. Source inspection is not runtime verification.

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

## Automated tests included (source only)

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

Tests do not prove hard isolation from synchronous CPU hangs. No real adapter exists. Timing checks allow bounded waiting but need actual execution for flakiness review.

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

Record actual command outputs, environment versions, browser and failures before changing this document's UNRUN status.
