# Neo THC: scope and requirements

Neo means **Network Environment Overview**. THC means **The Homelab Companion**.

Planning baseline, 13 October 2026. This document records intended behavior and proposed implementation choices. No working functionality, integrations, or passing tests are claimed.

## Scope and boundaries

A local-first network and homelab overview: what exists, how systems depend on each other, what changed, and what needs attention. Provide an initial discovery pass, ongoing scoped collection, responsive desktop/mobile interface, system recognition, and optional API connections.

Initial integration priorities: UniFi, OPNsense, Proxmox. QNAP and Nextcloud follow with product-version and capability checks. Initial operation is read-only toward managed systems.

Non-goals: automatic remediation, unapproved network reconfiguration, scanning outside approved scope, exploitation, guaranteed visibility into all devices/apps, mandatory cloud services, and a single security/privacy/usability score. Examples must not contain personal topology, credentials, or real incident details.

## Requirements

1. **Local operation.** Core inventory, collection, analysis, storage and interface work locally. Telemetry defaults off. Disclose external dependencies and transmissions.
2. **Controlled discovery.** Users define scopes and exclusions before collection. Discovered routes, interfaces or relationships never expand authorization automatically. Initial and ongoing collection share scope controls.
3. **Bounded jobs.** Enforce timeouts, concurrency limits, progress and cancellation. Retain useful partial results and interrupted status. Hung probes must not block a whole job.
4. **Unified identity.** Use internal asset IDs. IP/MAC addresses are evidence, not sole identity keys. Represent address reuse, multiple interfaces, duplicate observations and conflicting identities. Show uncertainty.
5. **Traceable evidence.** Record source, vantage, observation time and freshness. Preserve conflicts. Distinguish unknown, stale, stopped and unhealthy states; integration loss is not proof a device failed.
6. **Recognize, connect, enrich.** Offer relevant optional API connections for recognized systems. Show version limitations, capabilities, permission needs and connection status. Recognition does not imply authorization or a configured integration.
7. **Read-only adapters.** Allowlist operations verified for product/version. HTTP GET alone does not establish safety, particularly for OPNsense. Unknown or potentially mutating operations are unavailable initially.
8. **Secrets.** Keep secrets out of source control, client bundles, logs, fixtures and returned API payloads. Store local secret references separately from ordinary inventory. Redact diagnostic errors. Avoid unintended public exposure.
9. **Dependencies.** Link findings to evidence and known dependencies. Reachability does not establish service health. A synthetic NAS with failed NFS but healthy ping/SMB must show affected services without inventing a root cause.
10. **DNS diagnostics.** Identify resolver, queried name/type and vantage. Distinguish answers, latency, NXDOMAIN, SERVFAIL and timeout. Account for caching and split DNS.
11. **DNS boundaries.** Distinguish home.arpa from mDNS .local. Local DNS setup remains a proposal. Disclose external queries and recipients; do not leak private names. Distinguish advertised resolver, observed endpoint, upstream and application overrides. A collector result does not prove all devices/apps behave the same.
12. **Trade-offs.** Recommendations explain evidence, uncertainty, security benefit/exposure, privacy visibility/recipients, setup steps/decisions, ongoing maintenance/interruptions and recovery effort separately.
13. **Executive-function support.** Group related findings, offer concrete next steps and prerequisites, and support save/resume. Make burden visible and offer alternatives rather than one strictness ranking.
14. **Responsive interface.** Overview, Inventory, System, Connections, DNS and Activity screens. Keep provenance, freshness, uncertainty and next actions legible on desktop and mobile.

## Proposed architecture

TypeScript, React, Fastify and SQLite, with isolated collector workers. These are proposals, not installed or tested components.

Workers emit normalized observations. Reconciliation maintains identity and dependencies without discarding conflicts. Findings reference evidence. Cancellation and job limits must remain enforceable independently of individual probes. Core functionality needs no cloud service.

Adapters initially provide detection, capability reporting and collection. Live changes are outside the initial adapter contract.

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

Assess QNAP and Nextcloud support by version/capability, then endpoint profiling. Record unsupported capabilities explicitly. Extend the agreed requirements before adding new consequential actions.

## Verification status

All acceptance checks above are planned. No implementation tests have run. Repository documentation publication is separate from a working app or deployment.
