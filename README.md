# Neo THC

**Neo — Network Environment Overview**  
**THC — The Homelab Companion**

A local-first companion for understanding a home network and homelab through one responsive desktop and mobile web interface.

## Project status

Planning baseline, 13 October 2026. Scope and requirements are being recorded from the agreed product discussion. No working application, live integrations, deployment or passing test suite is claimed yet. The initial implementation task is currently blocked by coding usage availability.

## Product goals

- Catalogue systems using an initial discovery pass and ongoing observations, within explicitly selected scopes.
- Recognise supported platforms and offer API connectivity, enriching one inventory with provenance and freshness.
- Bring together UniFi, OPNsense and Proxmox first, with QNAP and Nextcloud compatibility assessed later.
- Provide DNS diagnostics and guided local DNS planning.
- Explain security and privacy options alongside setup, maintenance and recovery effort, including executive-function burden.
- Show dependencies and distinguish unknown, stale, stopped and unhealthy states.

## Initial milestone

A documented architecture and fixture-based inventory API and responsive interface, with automated tests. Sample data must be clearly labelled. Discovery and API integrations remain planned until implemented and verified.

## Safety and privacy boundaries

The first version is read-only. Explicit scope, cancellation, bounded jobs and operation allowlists are requirements. No live scans, device configuration, credential collection, external DNS transmission or deployment is authorised by publishing this repository. Secrets must never appear in client bundles, logs or fixtures. Telemetry is off by default; core functionality must not depend on a cloud service.

## Planning

See [the requirements baseline](docs/requirements.md) for scope, proposed architecture, data concepts, API families, delivery phases and acceptance criteria. Technology choices are proposals until implementation validates them.
