# Decision record: agentless collection and deployment modes

Date: 13 October 2026.
Status: **Product direction approved; remote-mode design and implementation pending.**

## Decision and scope

Prefer agentless APIs and read-only protocols whenever they provide the required capability. One installed site collector can gather evidence from many systems; that does not mean installing an agent on every endpoint. An endpoint agent is optional only for an explicit capability unavailable agentlessly. Its privileges, installation, enrollment and revocation require a separate reviewed design.

Support two deployment modes:
- **Colocated:** install the collector alongside the interface, with local API, analysis and storage available without a cloud dependency.
- **Split:** retain the collector on-premises while hosting the interface remotely.

This decision records the owner's intended architecture. It does not authorize a deployment, credential enrollment, security-setting change or transmission of real inventory.

## Component placement is not yet fully decided

“Remote interface” specifies UI hosting, not automatic relocation of the API, analysis, persistence or job-control service.

### Colocated mode

```text
On-premises site
  Managed systems <-- scoped read-only operations -- Site collector
                                                    |
                                         Local API / analysis / storage
                                                    |
                                           Locally served interface
```

The current code implements a loopback-only version of this arrangement with synthetic fixtures and explicitly approved IPv4 discovery. No credentialed platform API connection or remote hosting exists.

### Split-mode design envelope

```text
On-premises site                               Remote hosting
  Managed systems                             Static UI assets
        ^                                          |
  Site collector                             Authorized user's browser
  Local credentials                                |
  Local scope policy                       Approved access/data path
        |                                  (not selected or implemented)
        +-- proposed outbound authenticated,
            encrypted channel --> Paired service, only if selected
```

The paired service and the locations of API, analysis, storage and job authorization remain decisions to make. Options include a remotely served static UI with an approved path to a site-local backend, or an explicitly enabled hosted service receiving a minimized data set. Neither option is implemented or selected by this document. There is no assumed tunnel, public collector port, browser-to-loopback exception or cloud upload.

A static host serving HTML/JavaScript does not automatically need inventory storage. However, its delivered code runs in the user's browser and may be able to read displayed data. Remote code trust, update integrity, browser origins and actual recipients still require review; static hosting alone is not a privacy guarantee.

Before implementing split mode, record:
- The exact placement of UI, API, analysis, persistence and job authorization
- Who operates each component and receives each category of observations, identifiers, diagnostics and metadata
- Whether remote scheduling is needed, its allowed operations and local approval model
- The authenticated browser-access path, transport protocol and peer-verification policy
- Storage location, encryption/access controls, local/remote retention, export/deletion and incident/revocation behavior

## Collector boundary and required trust design

The following are proposed design requirements, not implemented security features:

1. **Local credentials and authority.** Managed-system credentials stay at the collector site; UI and hosted services must not receive them. Keep secret references separate from observations and exclude secrets from logs, error bodies, buffers and browser payloads. Site credentials and channel-authentication material are distinct. New persistent access or enrollment is an explicit setup action.

2. **Outbound authenticated encrypted channel.** Prefer a collector-initiated connection to a specifically approved peer, with encrypted transport and verified peer identity. This direction avoids assuming inbound collector reachability. TLS errors must fail closed; no certificate-bypass path is proposed. The protocol and authentication mechanism remain undecided.

3. **Explicit pairing and site identity.** Pair a collector with a specific site and authorized recipient/control service through a deliberate owner step. Bind observations and requests to that site and collector identity. Namespace asset identity by site/installation; prohibit cross-site ingestion and job confusion. Define identity rotation and replacement without silently treating a new collector as the old trusted source.

4. **Local scope enforcement.** The collector is the final authority on permitted targets, exclusions, read-only operation IDs, versions, time limits and concurrency. A remote interface cannot expand these from discovered routes or inventory. If remote scheduling is later enabled, it may request only schema-validated, authenticated, explicitly authorized bounded jobs under that policy. Do not accept arbitrary commands, shell/script execution, modules, URLs, unapproved scans or managed-system changes. Expose cancellation and retain local stop controls.

5. **Minimized, redacted data.** Agree on the minimum normalized evidence and metadata needed for the selected mode before sending anything off-site. Inventory names, addresses and relationships can reveal private topology even without passwords. State recipient and purpose, redact before serialization and logging, and avoid raw response/error-body uploads. A local-only choice must remain useful.

6. **Retention and bounded offline delivery.** Specify separate local and remote retention policies, disk/memory quotas and protected storage. Bound any durable outbound spool. When limits are reached, apply visible backpressure or pause authorized collection; do not grow indefinitely, discard history silently or claim unsent data was delivered. Offline collection may continue only under existing local authorization and limits. No remote connection may be required to stop local work.

7. **Reconnect, sequence and idempotency.** Design versioned envelopes bound to site, collector, stream/epoch and sequence/event IDs. Acknowledge only after durable acceptance; retries of the same event must not duplicate observations or jobs. Detect conflicting reused IDs, gaps, out-of-order/replayed messages and stale session epochs. Resume from an agreed cursor with bounded retry/backoff and batch sizes. Preserve original observation time and freshness through buffering; reconnect receipt time must not make old evidence fresh.

8. **Revocation and failure behavior.** Provide explicit unpair/revoke and credential/channel-key rotation flows. Rejected or revoked peers cannot submit new jobs or receive further data. Define treatment of active jobs, buffered data and already received copies; revocation cannot silently claim deletion of remote copies. Keep local status and retained evidence accessible as authorized. Disconnection is an unknown/stale condition, not evidence that managed systems are down. Test fail-closed behavior and recovery without loosening trust or scope.

## Acceptance gate before implementation or exposure

Review threat models for malicious hosted UI code, compromised collectors, peer impersonation, replay, cross-site confusion, oversized data, stale queues and revoked identities. Then test normal delivery, duplicate/conflicting events, loss/reordering, offline limits, reconnection, cancellation and revocation.

Remote control, channel authentication, pairing and hosted storage must pass implementation and security review before use. An optional endpoint agent needs its own narrower acceptance gate; it is not a shortcut around these requirements.

## Current runtime remains unchanged

The application still binds only to 127.0.0.1 and serves synthetic fixtures. Current Host/Origin restrictions, CSP, read-only fixture operations, worker limits, job bounds and local SQLite storage remain intact. No transport, pairing credentials, enrollment UI, hosted API/storage, tunnel or deployment is added by this decision record. Do not expose the current unauthenticated local API to the LAN or internet.
