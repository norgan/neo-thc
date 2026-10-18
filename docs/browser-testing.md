## Current playback and desktop verification (18 October 2026)

Candidate version **0.2.0**, runtime **playback-desktop-v7**. Windows source checks passed **110 unit tests**, zero failures/skips, server/web/browser typechecks and production build. The final desktop/mobile Chromium run passed **48 cases**, including real HTMLVideoElement dimensions/frame counters from an isolated canvas stream, report privacy validation, preview/save/reload and mobile reflow. Fixtures are not real Netflix or YouTube service acceptance.

The actual packaged Windows app payload starts its owned utility-process collector, renders packaged assets, creates a valid schema-3 database and exits with its listener closed. A separate Electron UI integration test loads the exact packaged application files with the same pinned runtime and exercises Settings IPC: standalone → authenticated private-CA TLS service → standalone, no credential API in the main renderer, session-only token absent from disk, and clean shutdown. The native file chooser is stubbed only in that isolated test. Playwright must own its app-ready loader for this test; packaged-EXE startup is checked separately.

`node scripts/desktop-smoke.mjs` and `node scripts/desktop-integration.mjs` use temporary profiles and loopback fixtures. The optional portable-launcher test allows a bounded 180 seconds for extraction/first launch; normal installed-payload smoke is bounded to 60 seconds. Linux CI checks compiled transports and process-group shutdown separately; current exact-head evidence belongs in the PR/CI results.

The Windows desktop includes Electron 44.9.0 / Node 24.22.0; source and server tooling require Node 24. The checked dependency audit reported zero vulnerabilities. Windows x64 portable and per-user installer outputs plus a separate Node 24 server bundle are generated under release. Packages are currently unsigned. Real second-host deployment, protected Netflix sessions, browser-store publication, physical TV/phone playback, Linux Wi-Fi and other desktop OS packages remain unverified or outside this release.

# Current browser suite: home-support-v6

The suite has 21 cases in each of the two Chromium viewports (42 total). Diagnostic cases cover DNS preview/consent and IPv6 configuration, custom DNS ports, missing AAAA explanations, exact-address connection comparison, slow resolver/TTL/history interpretation, and cancellation/stale-API locking. Home streaming cases cover exact recipients, optional download budget, local settings, latency/MTU/capacity interpretation, responsive layout and interrupted evidence without final verdicts. Data is controlled; no browser test submits public/LAN diagnostics. Read [current PR checks](https://github.com/norgan/neo-thc/pull/1/checks) for exact-head evidence.

## Previous network-overview-v4 evidence

The current suite has 14 cases in each of two Chromium viewports: 1440×1000 desktop and 375×812 mobile emulation. **All 28 passed locally on Windows on 14 October 2026 (1.3 minutes).** The run used the production build, Node 24.19.0, Playwright 1.64.0 and its pinned Chromium 156.0.8078.4. No physical-device or cross-browser claim follows from viewport emulation.

Coverage includes empty NOC startup; local-config prefill; exact TCP budgets and validation; preview/consent/repeated-submit controls; real/synthetic evidence separation; active-job cancellation; per-method outcomes and API recovery; keyboard/navigation; friendly systems; partial/zero Glances metrics; stale-API locking; modal focus, preserved edits and browser history; combined common-port/automatic-Glances consent; and NOC capacity/Network presentation. API interceptions use controlled test data and do not initiate a user-network scan. Each case rejects uncaught browser errors and external app requests.

The isolated production-server harness has a ten-second startup limit and a five-second cleanup limit. POSIX SIGTERM teardown is checked in Linux CI. Windows process.kill terminates the child directly; direct Windows shutdown coverage comes from tests/shutdown.test.ts, not this process-signal harness. See [current PR checks](https://github.com/norgan/neo-thc/pull/1/checks) for the exact published head and [testing](testing.md) for local evidence and limits.

The following records describe historical fixture UI, counts and lockfile provenance, not the current interface.

## Historical real-only browser suite

All 16 cases passed at 7002b4a in [run 38344284713](https://github.com/norgan/neo-thc/actions/runs/38344284713); review follow-ups added the System freshness poll assertion. That suite had eight cases in each of two Chromium viewports (16 total): real-only empty startup; actual-config prefill and manual edits; budget/token correction; preview/consent/repeated-click prevention; real evidence with synthetic-row exclusion; active-job lock/cancel; partial outcomes and API recovery; keyboard/navigation/link-wide consent. Browser API data was intercepted where needed; no live scan occurred.

# Browser verification

## Scope and status

**Passed:** all 16 desktop/mobile Chromium cases at source head 31cb874469725f147066ed7035f3bfc6012fc0ff in [run 38340290987](https://github.com/norgan/neo-thc/actions/runs/38340290987) on 13 October 2026 (51.1 seconds). Read current PR checks for subsequent review corrections. Earlier inventory/evidence screenshots were visually inspected; this run's discovery cases verify the intercepted controls programmatically.

Pinned Microsoft Playwright 1.64.0 runs bundled Chromium on a GitHub-hosted Linux runner. The direct version and Node >=20 contract were checked against the [official package](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-test/package.json) and [release](https://github.com/microsoft/playwright/releases/tag/v1.64.0). Node 24 remains the application runtime.

Two projects use a 1440×1000 desktop viewport and a 375×812 mobile Chromium emulation. This is not a physical-device, Safari or Firefox claim.

## Included flows

Each case gets a fresh production server and temporary SQLite database. Cases run sequentially; no existing server is reused.

1. Empty inventory → initial collection → six assets → NAS provenance/service evidence. Check stale historical address identity and ambiguity; capture inventory and evidence screenshots.
2. Saved scope selection across reload, exclusions, and absence of excluded assets.
3. Hold submission response while attempting repeated clicks; verify one job. Navigate during live collection, cancel, preserve inventory, and permit later work.
4. Simulate API network failure in the browser. Preserve visible inventory with an explicit stale-data warning; retry and recover without submitting another job. Capture error-state screenshot.
5. Named navigation, form labels, main/heading structure, live-status region, keyboard focus and activation, selected navigation state, no document overflow at either viewport, and explicit planned Connections/advanced-DNS boundaries.

6. Opt in to the simulated Proxmox target, collect its five resources, verify four unknown/one stopped health projections and inspect permission-filtered provenance; capture evidence screenshot.

7. Discovery is inactive with no preselected scope/methods; intercepted preview and submission validate explicit confirmation, invalidation after edits and repeated-click prevention. No real discovery job is submitted.
8. Distinct mDNS/SSDP multicast and legacy NBNS broadcast labels, unselected link-wide approval and viewport overflow checks.

Every case rejects uncaught browser errors and blocks/reports attempted external app requests. All app traffic is to the runner's 127.0.0.1 fixture API. Screenshots and traces contain only synthetic fixtures.

## Limits and artifacts

The job is bounded to ten minutes; the browser suite to three minutes, each case to thirty seconds, startup to ten seconds and graceful shutdown to five seconds. Failure traces/screenshots and selected successful screenshots are saved alongside an HTML report in the browser-qa artifact for three days.

These are functional and basic semantic/keyboard checks, not a full accessibility audit. Automated viewport checks and captured screenshots do not establish physical touch-device usability, all screen-reader behavior, every color-contrast requirement, or compatibility across browsers.

## Commands

After `npm ci` and `npm run build`, install the pinned browser with:

```sh
npx --no-install playwright install --with-deps chromium
npm run test:browser
```

The fixture lifecycle is intended for the Linux CI runner. Browser installation downloads Microsoft Playwright browser packages and may install OS dependencies; no browser or app was installed on the owner's computer. The repository was not executed locally during authoring.

## Updated authentic lockfile

Playwright was added through an authorized CI bootstrap using npm install, then its real generated package-lock.json was retrieved and verified before restoring npm ci.

- Source run: https://github.com/norgan/neo-thc/actions/runs/38332634294
- Artifact ID: 11782843030
- ZIP SHA-256: 99027ca425e8f23ace3b29372b385448f5fb9d0aae804dae3152e12048e2252d
- Exact lockfile SHA-256: e23f64b17b029eabc206250d11e9d78bc5cbc1c59a31bc2fb4f9e4ea293c4914
- Size: 79,239 bytes; lockfile version 3

Data-only inspection checked the archive's sole path and size, digest, root dependency/engine match, exact direct pins, and registry URLs. The resulting lockfile is committed unchanged; no repository code was executed by that inspection.
