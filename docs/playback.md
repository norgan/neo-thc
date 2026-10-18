# Actual playback diagnosis

Runtime **playback-desktop-v7** adds user-started capture from the video actually playing in Edge/Chrome. It does not embed Netflix in Electron, emulate playback, infer resolution from bandwidth, or bypass DRM. The companion's Manifest V3 activeTab grant permits injection only after its toolbar is used; there are no persistent host permissions, content scripts, webRequest interception, cookies or browser-history permissions.

The self-contained sampler runs in the isolated scripting world on the selected YouTube/Netflix top-level tab. It chooses the visible playing video before paused elements and uses a 20-second default sample. It can be stopped, removes its listeners/observer, and ends on hidden tab, ended video or detached player. It never changes playback settings. A service worker retains the minimized result in session storage, so closing the popup does not lose a running capture. A stale interrupted capture can be restarted.

## Measurements and interpretation

- `videoWidth`/`videoHeight`: decoded video dimensions, including changes over the sample. This does not attest HDR, display resolution, account-plan limits, advertisements or selected quality settings.
- `buffered` ranges relative to `currentTime`: seconds of buffered media ahead where available. A sample of zero is distinct from unavailable.
- `waiting` after playback started: event count and observed waiting duration, excluding deliberate pause/seek periods. Startup buffering is not rebuffering. `stalled` is counted separately and does not itself establish a visible stall.
- `getVideoPlaybackQuality`: total/dropped frame counter deltas. Missing APIs, reset/inconsistent counters and no decoded frames yield unknown. Old lifetime counts are not misrepresented as sample drops. Hidden/paused/seek state remains visible.
- Optional long-task timing: activity in the player page, not total CPU or proof of decoder overload.
- Browser connection estimates: coarse browser-reported values, not native Wi-Fi signal or an Internet speed test. The report does not contain IPs, SSID/BSSID, account details, page/title/URL or media.

Reports are at most 64 KiB, schema 1, with at most 131 bounded samples and 65 seconds measured duration. Unknown or extra fields are rejected before import/transmission. Import is previewed before saving; up to 200 reports persist in SQLite schema 3 independently of inventory. Imported reports are client claims: the collector validates the format and cannot attest their origin or that a file was never edited.

## Device correlation and placement

An explicit device read uses a short CPU/memory snapshot and fixed bounded `netsh wlan show interfaces` on Windows. It retains signal percentage, negotiated receive/transmit rates, radio type and channel only. It does not retain raw output, SSID, BSSID, MAC or interface identity. Multiple/ambiguous links, localized/unrecognized output, Windows location restrictions and no connected Wi-Fi remain unavailable. Linux Wi-Fi is currently unsupported. No permissions or network settings are changed.

Desktop remote mode performs these reads on the desktop. Discovery, DNS/ping/MTU/capacity and persistent reports belong to the selected collector. The UI labels placement and warns about timestamp mismatch. A playback report from another device cannot automatically be matched to desktop Wi-Fi; only compare measurements from the same computer during the symptom.

Dropped frames with healthy buffer suggest investigating decoding/GPU/power/device load. Rebuffering with empty buffer calls for concurrent Wi-Fi, gateway and upstream evidence. Neither pattern alone establishes a cause. Netflix plan/browser/DRM eligibility, TV/phone telemetry, codec-specific decode timing, sustained CDN testing and automatic synchronized collection remain outside this release.

## Verification boundary

Unit tests exercise the actual serialized sampler with controlled waiting/seek/frame/reset evidence. Browser tests exercise real Chromium HTMLVideoElement dimensions and frame counters using an isolated canvas stream, and persisted import/reload/mobile behavior. Those fixtures are not real YouTube/Netflix service acceptance. Real protected Netflix playback requires an authorized account/session and explicit companion installation by the browser owner; no credentials are collected or test results invented.

Primary API references: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [video playback quality](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality), [Netflix browser requirements](https://help.netflix.com/en/node/30081), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
