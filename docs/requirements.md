# Neo THC: scope and requirements

Neo means **Network Environment Overview**. THC means **The Homelab Companion**.

Planning baseline created 13 October 2026; updated the same day with the owner-approved agentless-first and two-mode deployment direction. This document records intended product behavior. A local real-only discovery foundation and opt-in Glances stats slice now exist; see [verification](testing.md) and current PR checks. Planned requirements are not claims that every platform integration or remote deployment works. Current implemented boundaries are described in the README and Glances/discovery documents.

## Scope and boundaries

A local-first network and homelab overview: what exists, how systems depend on each other, what changed, and what needs attention. Provide an initial discovery pass, ongoing scoped collection, responsive desktop/mobile interface, system recognition, and optional API connections. Prefer agentless collection. Support a collector installed alongside the interface, or an on-premises collector with a remotely hosted interface; the latter is a planned mode, not available in the current runtime.

Initial integration priorities: UniFi, OPNsense, Proxmox. QNAP and Nextcloud follow with product-version and capability checks. Initial operation is read-only toward managed systems.

Non-goals: automatic remediation, unapproved network reconfiguration, scanning outside approved scope, exploitation, guaranteed visibility into all devices/apps, mandatory cloud services, and a single security/privacy/usability score. Examples must not contain personal topology, credentials, or real incident details.

## Requirements

1. **Local operation.** Preserve a fully local mode for core inventory, collection, analysis, storage and interface, without a mandatory cloud service. A split deployment is optional and explicit. Telemetry defaults off. Disclose external dependencies and transmissions.
2. **Controlled discovery.** Users define scopes and exclusions before collection. Discovered routes, interfaces or relationships never expand authorization automatically. Initial and ongoing collection share scope controls.
3. **Bounded jobs.** Enforce timeouts, concurrency limits, progress and cancellation. Retain useful partial results and interrupted status. Hung probes must not block a whole job.
4. **Unified identity.** Use internal asset IDs. IP/MAC addresses are evidence, not sole identity keys. Represent address reuse, multiple interfaces, duplicate observations and conflicting identities. Show uncertainty.
5. **Traceable evidence.** Record source, vantage, observation time and freshness. Preserve conflicts. Distinguish unknown, stale, stopped and unhealthy states; integration loss is not proof a device failed.
6. **Recognize, connect, enrich.** Offer relevant optional API connections for recognized systems. Show version limitations, capabilities, permission needs and connection status. Recognition does not imply authorization or a configured integration.
7. **Read-only adapters.** Allowlist operations verified for product/version. HTTP GET alone does not establish safety, particularly for OPNsense. Unknown or potentially mutating operations are unavailable initially.
8. **Secrets.** Keep secrets out of source control, client bundles, logs, fixtures and returned API payloads. Keep managed-system credentials and local secret references at the collector site, separately from ordinary inventory; remote interface hosting does not authorize uploading them. Redact diagnostic errors. Avoid unintended public exposure.
9. **Dependencies.** Link findings to evidence and known dependencies. Reachability does not establish service health. A synthetic NAS with failed NFS but healthy ping/SMB must show affected services without inventing a root cause.
10. **DNS diagnostics.** Identify resolver, queried name/type and vantage. Distinguish answers, latency, NXDOMAIN, SERVFAIL and timeout. Account for caching and split DNS.
11. **DNS boundaries.** Distinguish home.arpa from mDNS .local. Local DNS setup remains a proposal. Disclose external queries and recipients; do not leak private names. Distinguish advertised resolver, observed endpoint, upstream and application overrides. A collector result does not prove all devices/apps behave the same.
12. **Trade-offs.** Recommendations explain evidence, uncertainty, security benefit/exposure, privacy visibility/recipients, setup steps/decisions, ongoing maintenance/interruptions and recovery effort separately.
13. **Executive-function support.** Group related findings, offer concrete next steps and prerequisites, and support save/resume. Make burden visible and offer alternatives rather than one strictness ranking.
14. **Responsive interface.** Overview, Inventory, System, Connections, DNS and Activity screens. Keep provenance, freshness, uncertainty and next actions legible on desktop and mobile.

15. **Agentless first.** Use permitted platform APIs and read-only protocols wherever they provide the needed capability. Installing one site collector does not require an agent on every managed endpoint. An endpoint agent is optional only for explicitly documented capabilities unavailable agentlessly, with separate installation/enrollment and least-privilege review.
16. **Two deployment modes.** Support colocated collector/interface and an on-premises collector with a remotely hosted interface. Preserve the local mode's safeguards. Hosting static interface assets remotely is a separate decision from remotely hosting API, storage or a control plane; do not infer permission to transmit inventory or move storage.
17. **Collector trust boundary.** Before split mode is implemented, define explicit pairing, site identity, local scope enforcement, an outbound authenticated encrypted channel, data minimization/redaction, local and remote retention, bounded offline buffering/backpressure, reconnect/sequence idempotency and revocation. Remote requests must never introduce arbitrary commands or unapproved scans. Remote control functionality remains planned and requires implementation and security review.

## Proposed architecture

The local synthetic foundation uses TypeScript, React, Fastify, SQLite and isolated collector workers. Real collection, endpoint agents and split deployment remain planned.

Workers emit normalized observations. Reconciliation maintains identity and dependencies without discarding conflicts. Findings reference evidence. Cancellation and job limits must remain enforceable independently of individual probes. Core functionality needs no cloud service.

Adapters initially provide detection, capability reporting and collection through agentless interfaces. Live changes are outside the initial adapter contract. Keep the site collector as the local credentials, scope and execution authority in either deployment mode. The [deployment decision record](deployment-modes.md) distinguishes approved direction from unresolved API/storage/control-plane placement and proposed security design.

## Proposed data model

- Asset: internal ID, type, labels, candidate identifiers and identity confidence.
- Observation: subject, source, vantage, timestamps, freshness, result and evidence.
- Relationship/dependency: entities, relationship type, evidence and uncertainty.
- Integration: product/version, capabilities, connection state and local secret reference.
- Scan job: immutable scope snapshot, exclusions, limits, progress, lifecycle and partial results.
- DNS job: resolver, question, vantage, destination, measurements and outcome.
- Finding: affected entities, evidence, impact, uncertainty and incident grouping.
- Recommendation: proposed action, trade-offs, prerequisites, next step and saved progress.

Exact storage schemas and retention policies remain to be specified.

## Proposed API families

Under /api/v1: assets and details; observations; dependencies; findings and recommendations; integration candidates, connections and capability checks; scan jobs; DNS jobs.

Job operations cover submission, status, results and cancellation. Idempotent submission prevents duplicate work. Resumable event delivery is proposed for reconnecting clients. Exact schemas, authentication and transport details remain implementation decisions requiring review.

## Delivery backlog and acceptance

### 1. Fixture-based inventory foundation

Implement a bounded inventory API and responsive inventory/system views using clearly labelled synthetic data. Show stable internal IDs, evidence source, freshness and ambiguity.

Planned tests: IP reuse, duplicate observations, conflicting identity, unknown/stale/stopped/unhealthy distinctions, repeated interactions and empty/error states.

### 2. Scoped collection and first adapters

Add bounded initial/live discovery and UniFi, OPNsense and Proxmox adapters.

Acceptance: version-aware read-only operation allowlists; enforced scopes/exclusions; progress/cancellation; interrupted runs and retained partial results; tests for integration loss, repeated job submissions, redaction and hung-probe isolation. No device integration is complete merely because a UI card exists.

### 3. DNS and guided diagnostics

Add resolver/name/vantage diagnostics, evidence-backed dependencies, grouped incidents and resumable recommendations.

Acceptance: outcome distinctions, external-query safeguards, caching/split-DNS fixtures, and synthetic NFS failure example without unsupported diagnosis. Local DNS wizard produces a reviewable proposal and verification steps.

### 4. Later compatibility and endpoint profiling

Assess QNAP and Nextcloud support by version/capability, then endpoint profiling. Use an optional endpoint agent only for documented agentless capability gaps; record unsupported capabilities explicitly. Extend the agreed requirements before adding new consequential actions.

### Split-deployment acceptance gate (planned)

Before enabling remote interface or control functionality, decide and document exactly where UI assets, API, analysis, persistence and job authorization run, who can receive each data category, and what the owner must explicitly enable. Test authenticated site isolation, pairing/revocation, scope enforcement, redaction, replay/conflict rejection, duplicate delivery, offline capacity and reconnection. Prove that hosted UI changes cannot silently broaden local authority. No remote hosting, credential configuration, security-setting change or data upload follows merely from this product-direction decision.

## Discovery implementation milestone

An opt-in initial IPv4 discovery slice now has source for explicit interface/CIDR selection, PTR through a selected on-link resolver, bounded TCP connect probes, mDNS service-type multicast, SSDP root-device multicast and a limited legacy browse-master broadcast. It does not implement ping/ARP, general UDP scanning, IPv6 or real platform API connections. [Discovery documentation](discovery.md) specifies exact traffic, scope, evidence and validation limits. Source presence is not proof of physical network compatibility.

## Verification status

The full-product acceptance checks above remain planned. The local fixture foundation passed 27 unit tests, 12 desktop/mobile Chromium cases, typechecks, build and compiled-worker startup smoke at [source head 60c860e](https://github.com/norgan/neo-thc/actions/runs/38334947206). Those tests do not validate real integrations, agents or split deployment. Documentation publication is separate from deployment.
