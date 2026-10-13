# Friendly systems and Glances snapshots

## What is available

The Systems view prioritizes observed PTR names, service advertisements and cautious role suggestions. TCP acceptance gives a port hint; it does not verify HTTP, TLS, SSH or Proxmox. A Glances mDNS advertisement suggests a monitoring endpoint, not hardware metrics or a confirmed REST API. DNS-only names do not establish a direct device response. Silent attempts remain available in the diagnostics toggle.

The latest address/interface view groups past scan records for convenience without merging their stored identities. Newer address evidence does not inherit an old name, service claim or stats snapshot as current. Historical evidence remains available. IP reuse, proxies and untrusted names remain possible.

## Read actual metrics

1. Run a scoped discovery, or open existing real discovery results.
2. Select a system and choose **Connect system stats**.
3. Select the actual REST endpoint scheme and port. 61208 is Glances' documented default, clearly offered as a suggestion; it is not auto-detected.
4. Review the literal target IP, current source interface and exact reads. Approve and select **Read system stats**.
5. View reported CPU usage, memory percentage/available/total, uptime and each filesystem's capacity. A failed or partial refresh remains visible alongside earlier snapshots.

Glances must already expose a compatible REST API v4 endpoint. Neo does not install or configure Glances. This slice sends no credentials; 401/403 means authentication is required and stops remaining reads. Credentialed Glances and Proxmox integrations need a separate local setup/security design. Do not paste secrets into chat or put them in the repository.

HTTP reads are unencrypted and explicitly labelled. HTTPS always verifies certificates; no self-signed bypass exists. Using a literal IP requires a certificate valid for that IP. The interface and target must still satisfy Neo's current on-link scope. An advertisement is never permission to connect.

## Transport boundary

Only sequential GET /api/4/version, /api/4/system, /api/4/cpu, /api/4/mem, /api/4/fs and /api/4/uptime are compiled into the transport. Major version 4 must validate first. No URL, path, host name, headers, credentials or proxy configuration is accepted by the UI API. Requests use the selected literal IPv4 and source address, a private one-socket agent, normal TLS validation, no redirects and no retries. Environment proxies are not used.

Limits: six requests, two-second absolute request deadlines, twelve-second overall deadline, 8 KiB headers, 256 KiB body per response, 128 filesystem rows. Compressed or malformed responses are rejected. Cancellation destroys the socket; cleanup failure blocks later collection. Discovery and stats share one active collection slot. At most 500 stats snapshots are retained; reaching this safety cap stops further writes rather than silently deleting history.

Valid plugin sections survive another section failing. Missing, failed, empty and genuine zero values remain distinct. Filesystem entries are not summed because bind/overlay mounts can overlap. Glances' reported percentage is preserved; used plus free need not equal size. “Fetched” is Neo's receipt action time, not a guarantee that Glances refreshed its internal cached sample then.

## Endpoint discovery limitation

This version does not resolve mDNS instances/SRV/TXT/A into a REST endpoint. Glances uses _glances._tcp for both REST and XML-RPC. A future bounded resolver must require protocol=rest, an unambiguous SRV port and a matching A record for the already approved address, then still ask the user before HTTP reads. No advertised URL is followed.

## Verification and sources

Tests use isolated loopback HTTP fixtures and explicit injected API seams; no private topology, credentials or physical Glances installation is used in CI. The production smoke exercises the actual compiled transport. Browser tests exercise consent, repeated-click prevention, partial values and responsive presentation. Physical Glances/Windows interoperability remains unverified by this development session.

Official contracts reviewed: [Glances REST API](https://glances.readthedocs.io/en/latest/api/restful.html), [v4.5.8 REST implementation](https://github.com/nicolargo/glances/blob/v4.5.8/glances/outputs/glances_restful_api.py), [system plugin](https://github.com/nicolargo/glances/blob/v4.5.8/glances/plugins/system/__init__.py), [filesystem plugin](https://github.com/nicolargo/glances/blob/v4.5.8/glances/plugins/fs/__init__.py), [dynamic advertisement](https://github.com/nicolargo/glances/blob/v4.5.8/glances/servers_list_dynamic.py).
