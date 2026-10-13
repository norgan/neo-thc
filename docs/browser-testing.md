# Browser verification

## Scope and status

**Passed:** all 12 desktop/mobile Chromium cases, including simulated Proxmox evidence, at source head d459b88e8e3cf5c5adeda26e13f8ca0f58fb9180 in [run 38334676302](https://github.com/norgan/neo-thc/actions/runs/38334676302) on 13 October 2026. The earlier 10-case baseline also passed; its desktop inventory and mobile evidence screenshots were visually inspected. Read current PR checks for later review corrections.

Pinned Microsoft Playwright 1.64.0 runs bundled Chromium on a GitHub-hosted Linux runner. The direct version and Node >=20 contract were checked against the [official package](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-test/package.json) and [release](https://github.com/microsoft/playwright/releases/tag/v1.64.0). Node 24 remains the application runtime.

Two projects use a 1440×1000 desktop viewport and a 375×812 mobile Chromium emulation. This is not a physical-device, Safari or Firefox claim.

## Included flows

Each case gets a fresh production server and temporary SQLite database. Cases run sequentially; no existing server is reused.

1. Empty inventory → initial collection → six assets → NAS provenance/service evidence. Check stale historical address identity and ambiguity; capture inventory and evidence screenshots.
2. Saved scope selection across reload, exclusions, and absence of excluded assets.
3. Hold submission response while attempting repeated clicks; verify one job. Navigate during live collection, cancel, preserve inventory, and permit later work.
4. Simulate API network failure in the browser. Preserve visible inventory with an explicit stale-data warning; retry and recover without submitting another job. Capture error-state screenshot.
5. Named navigation, form labels, main/heading structure, live-status region, keyboard focus and activation, selected navigation state, no document overflow at either viewport, and explicit planned Connections/DNS boundaries.

6. Opt in to the simulated Proxmox target, collect its five resources, verify four unknown/one stopped health projections and inspect permission-filtered provenance; capture evidence screenshot.

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
