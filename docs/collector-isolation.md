# Isolated synthetic collector milestone

## Scope

Seven registered targets are available. The original six examples stay selected by default; the seventh, **Simulated Proxmox inventory**, is opt-in. It represents one synthetic installation, demo-lab, with two nodes, two QEMU guests and one LXC guest. All snapshots stay synthetic. Initial/live modes perform one/repeated synthetic collection; neither connects to Proxmox.

The fixture profile accepts only version 8.4.22 with matching release 8.4 and a valid synthetic repository ID. This is source-derived parser compatibility, not a claim of live platform support.

## Fixed operations and validation

The frozen mock plan contains exactly:
- GET /api2/json/version
- GET /api2/json/cluster/resources?type=node
- GET /api2/json/cluster/resources?type=vm

Version validation precedes inventory. Node and guest failures are independent after that gate. Only the fake transport is implemented; there is no HTTP transport, dynamic URL, module/plugin loader, credential field or environment switch. API submissions accept registered target keys, not operations or transport settings. Excluding the integration excludes its entire inventory; there is no per-node scope control.

The pure normalizer accepts bounded JSON envelopes (256 KiB, 100 records per operation), checks types, identities, finite safe VM IDs, string lengths, duplicate conflicts and version consistency, then drops unknown fields. This is an explicit demo cap, not a Proxmox cluster-size limit. HTTP/error bodies and raw diagnostics are never persisted or forwarded. Failure codes are fixed. The parent independently validates each bounded wire batch and its attempt/target/operation; duplicates or mismatches fail that attempt.

## Worker lifecycle

Production invokes one fixed .mjs worker per target. It receives only a generated attempt ID, registered target, cycle and trusted internal fixture scenario. It has no Store handle, inherited environment or parent execArgv/preloads. Its runtime imports are built-in Node modules and a fixed relative .mjs module.

Each invocation has a parent deadline, including startup; default is 750 ms. Cancel, deadline, shutdown, invalid output and normal completion all terminate and await the worker. A one-second cleanup limit fails collection closed if termination cannot be confirmed. A new worker cannot reuse the slot before cleanup. Settled/aborted attempts cannot ingest more messages. At most one batch per operation and one completion are accepted; valid partial batches are persisted immediately, so a hung guest operation does not erase earlier node evidence.

Old/young heap and stack limits are conservative. This is trusted-code CPU/hang isolation, **not an OS security sandbox**. Workers retain Node/OS capabilities; resourceLimits exclude ArrayBuffers and cannot prevent every process-wide out-of-memory failure. A real integration needs additional reviewed security, TLS/destination, credential, permission and deployment design. Internal fault scenarios exercise hangs and malformed output; they cannot be selected through the public API or environment.

TypeScript checks and emits the .mjs files with allowJs/checkJs. Source and compiled runners resolve the same relative worker name without tsx loaders in the worker. Tests cover source startup and the production smoke checks the emitted worker.

## Evidence semantics

Only the parent chooses observation UUID, source, vantage, subject identity, timestamp and 60-second TTL. Proxmox time is Neo's receipt time, not the platform's original measurement time. The original historical-address fixture retains its own trusted older timestamp.

Resource identity is installation + node/name or installation + qemu/VMID (likewise lxc). VM migration therefore preserves an asset ID. Different installations remain distinct. VMID and node-name reuse remain unresolved identity limitations. This endpoint does not supply authoritative guest network identity, so no IP/MAC evidence is synthesized.

Running guests and online/offline nodes remain unknown service health. Only an explicit stopped, non-template guest maps to stopped. Template and unknown states remain unknown. Freshness expiry projects unknown without rewriting history.

Proxmox resource responses can be permission-filtered. Successful empty lists and omissions never prove completeness, delete prior assets, or turn missing guests into stopped observations. Evidence carries “Permission-filtered coverage: completeness unknown.” Failed refreshes retain prior timestamps and history. A failed later operation marks the job failed with a fixed partial-results message.

## Verification and remaining limits

The milestone adds focused unit tests, a desktop/mobile mock-inventory flow and actual compiled-worker startup smoke. Read the current PR workflow for pass/fail; source publication alone is not execution evidence. Existing identity, idempotency, bounded jobs, restart and storage-failure tests remain in the suite.

No live Proxmox, UniFi, OPNsense, agent, secrets, remote deployment or OS sandbox testing is included. Only the documented synthetic version is accepted.

## Primary references

- [Proxmox 8.4.22 resource endpoint and type filters](https://github.com/proxmox/pve-manager/blob/5aee9c094b1d5608e36fec9cf35c6f71c38a1bdc/PVE/API2/Cluster.pm#L222-L244)
- [VM.Audit filtering and node-stat permission checks](https://github.com/proxmox/pve-manager/blob/5aee9c094b1d5608e36fec9cf35c6f71c38a1bdc/PVE/API2/Cluster.pm#L496-L539)
- [Official version response schema](https://github.com/proxmox/pve-manager/blob/9c3f5e5258f73f31e273493232a79d615fd9e072/PVE/API2.pm)
- [Resource IDs and platform states](https://github.com/proxmox/pve-manager/blob/9c3f5e5258f73f31e273493232a79d615fd9e072/PVE/API2Tools.pm)
- [Node 24 workers, options and limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)
