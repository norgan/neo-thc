# Explicit-scope IPv4 discovery

## What runs

Discovery is separate from the synthetic fixture controls. No job starts when Neo launches, lists local interfaces, opens the Discovery screen or previews settings. The user must select the source interface, CIDR and methods, review exact budgets, and explicitly confirm Start. The API revalidates the current interface and approved scope; the worker rechecks its host-supplied request. Real discovery shares the existing single active job slot, cancellation, storage limits and shutdown path.

Implemented methods:
- **IP/TCP:** numeric IPv4 destinations and selected TCP connect ports. No application payloads, banners, ICMP ping or ARP enumeration.
- **Reverse DNS:** PTR queries for selected IPs through one explicitly selected on-link IPv4 DNS resolver, with fixed local source binding. No OS/public fallback or subsequent resolution of returned names. DNS may use UDP and TCP port 53; the selected resolver may forward upstream under its own policy.
- **mDNS multicast:** one legacy-unicast-response PTR query for _services._dns-sd._udp.local to 224.0.0.251:5353, from an ephemeral source port on the selected IPv4 address. Multicast TTL 255. This collects service-type claims, not complete service instances or every device.
- **SSDP multicast:** one fixed root-device M-SEARCH to 239.255.255.250:1900, MX 1 and multicast TTL 1. Retain a bounded USN claim only. LOCATION and other headers are discarded; no URLs, descriptions or UPnP control requests are fetched.
- **Literal IPv4 broadcast:** one NetBIOS NB Name Query for the special browse-master name, UDP 137, local-subnet broadcast address derived from the current interface, TTL 1. This is limited legacy browse-master coverage; many modern devices will never answer. No NBSTAT follow-up, registration, release or control traffic is sent.

IPv6, ping, ARP, UDP port scanning, full mDNS instance resolution, banners, fingerprints and real platform API adapters are not implemented. No privilege escalation or firewall/network-setting change is attempted.

## Scope and budget

- At most 256 addresses in one explicit CIDR contained in the selected interface subnet
- The actual link's network/broadcast addresses and the collector's source address are excluded from TCP/PTR targets
- Up to eight chosen TCP ports and at most 1,024 address/port attempts; concurrency 16, 400 ms connect deadline, sockets destroyed on completion
- At most 256 PTR queries; concurrency eight, resolver timeout/tries bounds, cancellation and an independent worker/job deadline
- One datagram per selected link-wide method; two-second receive windows, at most 256 received packets per method (including invalid/out-of-scope packets), 8 KiB per accepted datagram and one accepted result per sender
- One initial pass, a 60-second whole-job deadline, no retries, periodic scheduling or automatic scope restoration/start

TCP/DNS limits count attempts, not exact wire packets; operating-system TCP behavior and DNS TCP fallback may send extra packets. The UI previews this distinction.

Multicast and broadcast reach link-wide listeners, not just accepted response IPs. They require explicit link-wide approval and the entire actual /24–/30 interface subnet. Wider subnets, /31-/32 links, subset CIDRs and overlapping local-interface subnets are rejected for these methods. The broadcast address is never caller-supplied. Per-address exclusions are not supported for this first discovery slice; use a smaller CIDR for unicast-only work.

Every socket binds the selected local IPv4. Multicast also selects its outgoing interface explicitly. Source binding is not a universal operating-system routing-policy guarantee; Neo does not claim SO_BINDTODEVICE enforcement. Bind/send failures do not trigger an alternate interface or broader scope.

## Untrusted responses and evidence

Packet validation bounds headers, record counts, compression offsets/hops, label/name lengths and RDATA. Cyclic/truncated or mismatched packets are ignored. mDNS checks source port, transaction ID, repeated question and PTR owner. NBNS checks the fixed query's transaction, sender port, bounded NB/IN records and six-byte address-entry format. SSDP checks the response status, ST and bounded USN. Returned addresses and URLs never become new targets. Node does not expose incoming IP TTL through this UDP API; no receive-hop verification is claimed.

Each attempted IP produces one bounded **address candidate** observation, including silence/timeouts, so attempts are not silently counted as discovered devices. Source, UUID, job/address identity, observation time and freshness policy are assigned in the parent. Service health stays unknown. A TCP refusal may come from a firewall; a PTR name is an unverified naming claim; an advertisement may describe a proxy. None establishes a stable device identity.

Identity is scoped to the job plus address. Another job creates a separate candidate rather than permanently merging devices by IP or MAC. This deliberately conservative first model does not yet reconcile candidates across scans. Fixture evidence uses a separate synthetic marker/source, including the internal test-only discovery seam.

Normal network attempt evidence uses a 60-second freshness policy; mDNS/SSDP advertisement-bearing observations are capped at ten seconds. Late receipt/replay does not authorize new targets. Partial observations are persisted as batches arrive. Timeouts, response caps or errors leave prior data intact and a failed/timed-out/cancelled status as appropriate; silence alone is inconclusive.

## Local use and privacy

Start the loopback application normally, then use Discovery. Methods and scope start unselected. Preview does not send packets. Confirm only networks you are authorized to test. To stop, cancel in Activity or stop Neo.

The local database may contain private IP addresses, PTR names, interface details and advertisement claims. Nothing is uploaded by Neo; protect the database/backups and do not publish them. No account credentials are needed by these discovery methods. Do not expose the current unauthenticated API to a LAN, proxy or public tunnel.

A physical-network validation still requires the owner's chosen interface, authorized scope/methods and explicit local action. No such scan was performed during development.

## Verification boundary

CI uses synthetic interface descriptions, injected multicast/broadcast send seams and isolated loopback TCP/DNS fixtures. It never sends multicast or broadcast onto the GitHub runner's LAN. Source-mode and compiled discovery workers use the internal mock-only transport seam, which is inaccessible to API/environment settings and labels its evidence synthetic. Browser cases check preview/confirmation/reset behavior using intercepted discovery endpoints; they do not establish physical discovery interoperability.

Read current PR checks for execution status. Windows and physical network behavior, firewall effects, multihomed routing and actual responder coverage remain unverified. Real Proxmox transport is deferred.

## Protocol references

- [Node DNS Resolver](https://nodejs.org/docs/latest-v24.x/api/dns.html) and [UDP sockets](https://nodejs.org/docs/latest-v24.x/api/dgram.html)
- [mDNS one-shot queries](https://www.rfc-editor.org/rfc/rfc6762.html#section-5.1) and [legacy unicast responses](https://www.rfc-editor.org/rfc/rfc6762.html#section-6.7)
- [DNS-SD service-type enumeration](https://www.rfc-editor.org/rfc/rfc6763.html#section-9)
- [NBNS broadcast name query](https://www.rfc-editor.org/rfc/rfc1002.html#section-4.2.12)
- [Documented browse-master discovery](https://nmap.org/nsedoc/scripts/broadcast-netbios-master-browser.html): interoperability reference only; no Nmap code is included
- [UPnP device architecture / SSDP](https://www.upnp.org/specs/arch/UPnP-arch-DeviceArchitecture-v1.0-20080424.pdf)
