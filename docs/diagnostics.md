# Home tech support diagnosis

Available in **Diagnostics**, runtime **playback-desktop-v7**. Neo is a home tech support platform; discovery provides part of its evidence. This workbench investigates slow Internet/streaming, DNS, IPv4/IPv6 paths, MTU/settings and TLS without requiring a full network scan.

## Guided Internet and streaming check

1. Review the suggested system DNS server, or select up to three exact IPv4/IPv6 resolvers and their unicast DNS port. Port 53 is normal; a custom port can check a configured fallback such as Unbound. No public DNS resolver is substituted.
2. Review the detected gateway, edit its literal address if needed, or leave it blank to omit gateway pings. Local configuration reads do not send probes.
3. Optionally select the capacity download. It is off initially and uses at most **8 MiB of response body**, plus protocol overhead, from the fixed Cloudflare HTTPS test endpoint, for at most six seconds. It can use a data allowance and compete with other traffic. There is no upload or video-account login.
4. Review and approve the exact recipients, targets and budget. A run lasts at most **45 seconds** and saves partial results as they arrive.
5. Compare YouTube/Netflix A/AAAA answers, three gateway and three Internet ICMP samples, local MTU/DHCP/DNS-suffix/gateway configuration, IPv4 path MTU, and optional capacity. Each finding gives a next step. Repeat near a stall and compare timestamps; these are snapshots, not continuous monitoring.

The profile queries only **www.youtube.com** and **www.netflix.com** through the approved DNS recipients. It sends three ICMP echo samples to the selected gateway, if any, and **1.1.1.1**. Up to eleven additional IPv4 ICMP probes to **1.1.1.1** use fragmentation disabled, with payloads between 1200 and 1472 bytes. The optional HTTPS GET is fixed to **https://speed.cloudflare.com/__down?bytes=8388608**, with certificate verification, no redirects, cookies, credentials, upload or environment proxy. DNS answers do not trigger arbitrary address following.

Missing ICMP replies can reflect filtering or deprioritization; they are not proof of media packet loss. Success with a 1472-byte payload establishes at least 1500 bytes on that one IPv4 path, including the 28-byte IPv4/ICMP headers. A smaller MTU is concluded only when successful replies and explicit too-big results bound the size. A timeout remains inconclusive. This does not test IPv6 PMTU, every CDN, or MSS clamping directly, and it never changes MTU.

The download rate includes connection/setup time. Samples below 256 KiB or 100 ms do not produce a rate; all samples remain brief estimates. Results compare capacity with published [Netflix guidance](https://help.netflix.com/en/node/306) (5 Mbps for 1080p, 15 Mbps for 4K) and [YouTube guidance](https://support.google.com/youtube/answer/78358) (20 Mbps for 4K). Capacity does not establish actual resolution, sustained bandwidth, dropped frames, buffer health, DRM/codec support or video-CDN performance. Check the affected device's YouTube Stats for nerds or Netflix network check when those facts are needed. Loaded latency/bufferbloat remains further work. Actual browser playback evidence is now a separate [Playback workflow](playback.md); capacity results alone still cannot supply it.

Windows uses fixed PowerShell commands over native .NET interface metadata and .NET Ping, avoiding slow CIM lookups for these diagnostic settings. It records MTU, configured gateways, DNS addresses/suffix and IPv4 DHCP state; IPv6 DHCP stays unknown because that API does not expose it. Only one unique configured IPv4 gateway is suggested; ambiguity produces no suggestion. Diagnostic configuration reads run concurrently and are owned by the request/shutdown lifecycle. Linux reads interface/route metadata and uses the fixed iputils ping executable when available. Unsupported/unavailable measurements are explicit. A configured gateway does not verify actual route priority or every address-family path. Scoped link-local gateway addresses are not supported by this slice.

## Repeated DNS comparisons

The [DNS benchmark](dns-benchmark.md) compares selected system/public IPv4 and IPv6 resolvers, A/AAAA questions and UDP/TCP using pinned dns-bench 0.14.0. It has its own reviewed matrix, three-minute job bound and saved incremental results. Resolver discovery uses NEO's structured Windows interface read; numeric scoped IPv6 is supported by the benchmark. The targeted checks below retain their existing scope and provide the DNS error/TTL detail omitted by upstream's aggregate benchmark output.

## Targeted DNS and connection checks

1. Enter a full ASCII hostname without URL paths or credentials, or choose the YouTube/Netflix DNS shortcut. Select up to three literal DNS servers and one port. The first system-configured resolver is suggested; other interface entries, including IPv6, remain visible.
2. Optionally compare operating-system resolution. Its resolver chain uses OS configuration independently of the selected direct DNS port. Review and approve the name, recipients, port and operation count.
3. Inspect A/AAAA answers, TTLs, timings and outcomes. **NODATA** means the requested address-record type was not returned. **NXDOMAIN** is a missing-name or alias-target response. An A answer with AAAA NODATA explains why ping -6 can fail while IPv4 resolves; missing AAAA alone is not an IPv6 connectivity fault. Conflicting A-answer/AAAA-NXDOMAIN results are flagged separately.
4. Select up to four exact returned addresses and one service port. Review and separately approve TCP-only or hostname-verified TLS checks. No returned address is connected automatically.

DNS over an IPv6 resolver address is separate from a service publishing AAAA records or accepting IPv6 connections. OS resolution can use hosts entries, VPN policy, caching or other resolvers; its actual resolver and TTL are not observed. Short names depend on suffix policy and are not expanded silently. A failed query to a firewall-internal fallback from this collector does not establish that its forwarder cannot reach it.

The 500 ms DNS flag is a comparison aid, not a universal service limit. Different answers, negative outcomes or TTLs can reflect split DNS, filtering, caching or load balancing. A TCP connection followed by certificate rejection is distinct from an unreachable path. Passing TCP/TLS does not establish application health. Browser secure DNS and HTTP/3/QUIC remain outside the targeted checks.

## Scope, lifecycle and storage

- Targeted DNS/connection jobs have a 12-second bound. Sequential direct DNS and OS lookups have 1.5-second reported deadlines; connection checks have 1.5-second deadlines. Native OS resolution can outlive its reported timeout until fixed-worker cleanup.
- The Internet profile has a 45-second bound, direct DNS cancellation, fixed ICMP counts/payloads and the optional six-second/8 MiB body cap. OS subprocess output is capped at 32 KiB. Cancellation kills owned subprocesses and waits for closure; an unconfirmed one-second cleanup disables further collection. Native HTTPS requests are destroyed on completion, deadline and cancellation.
- All jobs share the single collection slot, idempotency, cancellation, shutdown, restart interruption recovery and storage-failure handling. Incomplete/cancelled/interrupted/failed reports retain evidence without final findings.
- Parent result validation checks exact name/resolver/port binding, allowed fields/outcomes, address families, TTLs, durations, sample counts, MTU evidence and rate arithmetic. Raw process/exception text and downloaded bodies are not stored.
- Connection addresses must come from a saved DNS diagnosis less than 15 minutes old. Loopback, unspecified, mapped, multicast and link-local endpoints are excluded. TLS uses literal IPs with the original hostname as SNI and certificate identity; no bypass, downgrade, HTTP, login or retry.
- Reports reuse existing SQLite job JSON and the 200-job cap. Schema stays v2; no migration, wipe or inventory identity creation is needed.
- Unqualified names, URLs, credentials and .local/.localhost names are rejected with an explanation. Scoped link-local resolver entries remain visible as unsupported configuration evidence.

## API and privacy

All routes retain localhost Host/Origin/client-header guards:

- GET /api/v1/diagnostics/options: bounded local configuration reads; no network probes.
- POST /api/v1/diagnostics/preview: validate and return exact plan/count/budgets; no probes.
- POST /api/v1/diagnostics/jobs: explicit boolean confirmation plus request ID.
- Existing job/snapshot/cancel routes expose saved reports, progress and cancellation.

Names, resolver/gateway addresses, settings and measurements are private local metadata. Protect the database as inventory. Approved DNS servers receive queried names and may forward them; OS lookups use configured policy. Public test recipients observe the collector's source IP. No inventory/report, credentials, media session or downloaded body is uploaded. Neo changes no DNS, DHCP/PTR, IPv6, firewall, router, browser or MTU settings. The unauthenticated API remains loopback-only.

## Verification and primary contracts

Unit tests cover fixed scope/consent, custom ports, missing versus conflicting records, sample/rate/MTU validation, transfer caps and redirect refusal, idempotency, shared capacity, cancellation, partial persistence and cleanup failure. Real isolated transports cover IPv4/IPv6 DNS on selected non-default ports, actual diagnostic workers, TCP and TLS. Desktop/mobile tests cover recipients/budgets, consent invalidation, findings and interrupted evidence. CI never queries the public Internet or runner LAN.

See [current PR checks](https://github.com/norgan/neo-thc/pull/1/checks) for the exact published head. Separately authorized Windows measurements exercise live configured DNS, ICMP/MTU and the bounded transfer; personal topology/results are outside source and CI. Successful snapshots do not establish that an intermittent stall is fixed.

Contracts: [Node DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html), [Node TCP](https://nodejs.org/docs/latest-v24.x/api/net.html), [Node TLS/HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html), [.NET interface metadata](https://learn.microsoft.com/en-us/dotnet/api/system.net.networkinformation.networkinterface.getallnetworkinterfaces), [.NET fragmentation option](https://learn.microsoft.com/en-us/dotnet/api/system.net.networkinformation.pingoptions.dontfragment), [Cloudflare download endpoint](https://github.com/cloudflare/speedtest), [negative DNS responses](https://www.rfc-editor.org/rfc/rfc2308), [application family selection](https://www.rfc-editor.org/rfc/rfc8305). Forced-family diagnosis differs from an application's normal concurrent/fallback algorithm.
