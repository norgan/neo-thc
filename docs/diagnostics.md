# DNS and IPv4/IPv6 connection diagnosis

Available in **Diagnostics**, runtime **network-diagnostics-v5**. This workbench diagnoses a selected hostname from the Neo collector. It is separate from the IPv4 discovery scanner and does not require a full network scan.

## Use it during a slow lookup or connection failure

1. Enter a full hostname without a URL path or credentials. Select up to three exact DNS server addresses. The first system-configured resolver is suggested; other interface entries, including IPv6, remain visible. No public resolver is substituted automatically.
2. Optionally compare operating-system resolution. Review the hostname, recipients and operation count, then approve the DNS checks.
3. Inspect A/AAAA answers, TTLs, individual timings and outcomes. Reaching a DNS server over IPv6 is separate from a service publishing IPv6 AAAA records. OS resolution can use hosts entries, VPN policy, caching or other resolvers; its actual resolver and TTL are not observed by this check.
4. Select up to four exact returned addresses and one service port. Review and separately approve TCP-only or hostname-verified TLS checks. DNS answers never trigger connections automatically.
5. Repeat the diagnosis near a failure and compare saved timestamps and recent timing. These are individual snapshots; there is no continuous monitor or automatic repeat.

Findings distinguish missing records, NXDOMAIN, OS not-found, SERVFAIL, refusal, timeout, resolver disagreement, slow replies, address-family reachability differences and certificate failure. Each gives a next step. The 500 ms timing flag is a comparison aid, not a universal DNS performance limit. Different answers/TTLs can be legitimate split DNS, filtering, caching or load balancing. A missing AAAA record alone is not an IPv6 fault. A TCP connection followed by certificate rejection is distinct from an unreachable IPv6 path.

Incomplete, cancelled, interrupted or failed work retains partial results without a final conclusion. Passing TCP/TLS does not prove application health or resolve an intermittent fault. Browser secure DNS, HTTP/WebDAV, video CDN requests and HTTP/3/QUIC are outside this slice. Failure timestamps and the application's actual destination may still be needed.

## Scope and limits

- DNS: one normalized, absolute ASCII hostname; one to three literal IPv4/IPv6 resolvers; A and AAAA only, plus an optional OS lookup. Each selected server receives the name and may forward it upstream. The OS lookup uses its configured resolver chain. No name is submitted before approval.
- Unqualified names, URLs, credentials and `.local`/`.localhost` names are rejected with an explanation. `.local` belongs to mDNS; this is a unicast workbench. Scoped link-local resolver entries are retained in configuration evidence but are not supported for direct queries.
- Connections: at most four explicitly selected addresses from a saved DNS diagnosis less than 15 minutes old, and one port. No wildcard scopes or family fallback. Loopback, unspecified, mapped, multicast and link-local endpoints are excluded from public submission.
- TLS connects to a literal IP with SNI and certificate verification for the original hostname. There is no verification bypass, downgrade, HTTP, login, credential attempt, URL following, redirect, retry or environment proxy. Connected results include the actual local source address.
- Sequential DNS operations use one resolver/try and a 1.5-second operation deadline. OS lookup also has a 1.5-second reported deadline. Sequential TCP/TLS checks have 1.5-second deadlines. Native OS resolution can outlive its reported timeout until worker cleanup; unconfirmed cleanup disables further collection.
- A fixed isolated worker has an 11-second deadline, a one-second cleanup bound and a 12-second overall job bound. Parent validation checks expected resolver/type/address, family, TTL, message size/order, counts and allowlisted outcomes. Raw exception text, response payloads and credentials are not stored.
- Diagnostic jobs share the single collection slot, idempotency, cancellation, restart interruption recovery, shutdown and storage-failure handling with discovery and Glances.
- Reports use existing SQLite job payloads and the existing 200-job cap. Schema remains v2; no migration or wipe is needed. Results do not create inventory assets or infer permanent identity.

## API and privacy

All routes retain the localhost Host/Origin/client-header guards:

- `GET /api/v1/diagnostics/options`: bounded local configuration reads; no DNS queries.
- `POST /api/v1/diagnostics/preview`: validate and return the exact plan/count; no probes.
- `POST /api/v1/diagnostics/jobs`: explicit boolean confirmation plus a request ID.
- Existing job/snapshot/cancel routes provide report history, progress and cancellation.

Names, resolver addresses, timings and returned IPs are local private metadata. Protect the database as you would inventory. The unauthenticated API remains loopback-only. Diagnosis changes no DNS, DHCP, IPv6, firewall, router or application settings.

## Verification and primary contracts

Unit tests cover scope/consent, saved-evidence binding, mapped/link-local exclusions, IPv6 configuration preservation, resolver/OS differences, partial conclusions, TCP versus TLS findings, bounded result validation, idempotency, shared capacity, cancellation, late/forged worker messages and real isolated DNS/IPv4/IPv6/TLS transports. Desktop/mobile browser tests cover consent, exact endpoint selection, findings, timing history, cancellation and stale-API locking. Linux smoke executes the actual compiled diagnostic worker against isolated loopback TCP, never the runner LAN.

See [current PR checks](https://github.com/norgan/neo-thc/pull/1/checks) for the exact published head. A user-authorized local Windows snapshot exercised real DNS and dual-family TLS; it did not reproduce the intermittent symptom. Personal topology/results remain outside the repository and are not CI fixtures.

Contracts: [Node DNS and OS lookup](https://nodejs.org/docs/latest-v24.x/api/dns.html), [Node TCP](https://nodejs.org/docs/latest-v24.x/api/net.html), [Node TLS](https://nodejs.org/docs/latest-v24.x/api/tls.html), [Happy Eyeballs/application family selection](https://www.rfc-editor.org/rfc/rfc8305). Forced-family diagnosis differs from an application's normal concurrent/fallback connection algorithm.
