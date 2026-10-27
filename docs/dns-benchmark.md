# DNS benchmarking with system resolvers and IPv6

NEO integrates [qwerty541/dns-bench](https://github.com/qwerty541/dns-bench) **0.14.0** into Diagnostics. It compares the DNS servers configured on the selected collector with explicit public candidates, records repeated lookup performance and reliability, and retains results in the existing job history. DNS settings are never changed by a benchmark.

## Run a comparison

1. Open **Diagnostics → DNS benchmark: system resolvers and IPv6**. NEO reads configured DNS addresses without sending DNS queries. On Windows it uses the existing fixed PowerShell/.NET interface metadata read, which retains IPv6-first lists and subsequent IPv4 entries.
2. The default selection includes every supported detected system resolver plus Cloudflare, Quad9 and AdGuard IPv4/IPv6 candidates. Inspect **Detected system DNS and public candidates** to see interface provenance and unavailable addresses. Equivalent addresses are deduplicated. More than 16 addresses requires explicit batches; the selection is not silently truncated.
3. The initial matrix checks `example.com`, `cloudflare.com` and `quad9.net`, **A and AAAA**, **UDP and TCP**, with ten lookup iterations per comparison and a one-second request timeout. Change the names, resolvers, DNS port and bounded settings as needed. Public recipients receive every selected name, so keep private/split-DNS names out of public comparisons.
4. **Review DNS benchmark** lists the exact names, recipients, protocols, iterations and deadline. Start the approved comparison. No DNS traffic is sent merely by opening or previewing it.
5. Inspect the resolver summary and individual measurements. Cancel at any time; completed comparisons remain saved. Activity can reopen the benchmark and cancel its job.

An IPv4 resolver can return AAAA answers, and an IPv6 resolver can return A answers. NEO tests these independently. The default number of comparisons is `selected resolvers × 3 names × 2 protocols × 2 record types`; lookup iterations multiply this by ten. These are lookup iterations, not a claim about an exact DNS packet count: alias resolution can involve more than one exchange.

System DNS in remote mode means the **selected collector's** configuration. It does not establish the Windows desktop's configuration, browser secure-DNS provider, VPN policy or application overrides. Run standalone on the affected computer to measure that computer's path, then compare a separate collector run if useful.

## The reported system-DNS error

Upstream 0.14.0 can print:

```text
Failed to retrieve system DNS servers: No DNS servers found.
```

Its [Windows parser](https://github.com/qwerty541/dns-bench/blob/v0.14.0/src/system.rs) reads `ipconfig /all` and splits the DNS line on every colon. This breaks an IPv6 address on that line. Continuation addresses are considered only after a valid first address has already been collected. An IPv6-first list can therefore leave the parser empty even when Windows DNS works. The [caller](https://github.com/qwerty541/dns-bench/blob/v0.14.0/src/bench.rs) treats this as a warning and continues with the built-in or custom list.

NEO bypasses that parser with `--skip-system-servers`, while explicitly supplying the real configured resolver addresses in a custom list. **System DNS remains included.** `--skip-gateway-detection` prevents the executable from adding another unreviewed recipient or sending its hidden gateway responsiveness query. A gateway is tested when its DNS address is among the selected resolvers.

Explicit numeric IPv6 link scopes such as `fe80::1%12` are supported. The Rust socket parser accepts the numeric scope; NEO retains it in the plan, process input and report even though upstream JSON returns only the bare IP. Bare link-local addresses require an interface and named scopes are unsupported; both remain visible with an explanation. NEO never guesses an interface.

## Interpreting the preferred candidate

The summary gives full measurement coverage and successful lookups precedence over average latency. Only a completed job with every selected comparison measured and every lookup successful can identify the **lowest mean among fully successful tests**. Partial, timed-out, unavailable and malformed results cannot produce a preferred resolver or an invented zero-millisecond timing.

Individual cells retain the hostname, resolver transport family, protocol, record type, counts, min/mean/max successful latency and last successful answer. Returned addresses may reflect filtering or split DNS; a syntactically successful address is not automatically the intended answer. Upstream aggregates failures and cannot reliably distinguish NXDOMAIN, NODATA, refusal and timeout in this output. Use NEO's existing targeted DNS diagnosis for those distinctions. An absent AAAA record alone does not prove IPv6 connectivity failure.

Repeated names warm resolver caches. The benchmark does not measure a controlled cold-cache distribution, percentile latency, DNSSEC validation, encrypted DNS (DoH/DoT), content-filter equivalence or the entire application/network path. It does not flush operating-system or resolver caches. Compare the same scope during normal operation and during a problem, and preserve local-name resolution, filtering and privacy requirements before changing DNS.

The built-in public comparison choices have different policies:

| Provider | IPv4 | IPv6 | Published service policy |
| --- | --- | --- | --- |
| Cloudflare | `1.1.1.1` | `2606:4700:4700::1111` | Standard resolver without content filtering |
| Quad9 | `9.9.9.9` | `2620:fe::fe` | Threat blocking |
| AdGuard | `94.140.14.14` | `2a10:50c0::ad1:ff` | Advertising and tracker blocking |

Endpoints and policy labels were checked against [Cloudflare](https://developers.cloudflare.com/1.1.1.1/ip-addresses/), [Quad9](https://docs.quad9.net/services/) and [AdGuard](https://adguard-dns.io/en/public-dns.html) on 27 October 2026. The UI exposes these as comparison candidates rather than silently replacing system DNS.

## Install and package the engine

New Windows x64 packages built from this change bundle the pinned executable and its MIT licence. The existing published 0.2.1 preview does not acquire this feature automatically.

For a Windows source checkout:

```powershell
npm.cmd ci
npm.cmd run setup:dns-bench
npm.cmd run build
npm.cmd start
```

`package:desktop` provisions the Windows executable before packaging. `package:service` includes it when built on Windows. The build script verifies the release size (**8,114,016 bytes**) and SHA-256 before installing the generated tool. The binary is ignored by Git; its [manifest](../third-party/dns-bench/manifest.json) and [licence](../third-party/dns-bench/LICENSE-MIT) are tracked. There is no runtime download or installer launch. On networks requiring an environment proxy, Node 24 can run the setup script with `node --use-env-proxy scripts/setup-dns-bench.mjs --windows-x64`.

For a native Linux/macOS collector with Rust available:

```sh
cargo install --locked --version 0.14.0 dns-bench
```

Make that executable available to the service account on `PATH`, or set the administrator-controlled `NEO_DNS_BENCH_PATH` to its absolute path before starting NEO. The same variable can override the bundled Windows path. The API accepts neither executable paths nor arbitrary arguments. The existing Docker recipe does not install Rust or this optional native tool: supply a compatible pinned executable in the image if benchmarking is required there. Container results describe the container's configuration and routing.

NEO checks `dns-bench --version` with a bounded subprocess and requires exactly 0.14.0. A missing or mismatched tool is shown as unavailable and does not disable existing DNS or Internet diagnostics. The Windows release URL and digest come from the [upstream release](https://github.com/qwerty541/dns-bench/releases/tag/v0.14.0).

## Execution and data contract

- At most 16 resolvers, three names, two protocols, two record types, 50 iterations per comparison and a one/two-second request timeout. Default ten iterations. Up to four comparison processes run concurrently; a cell has a 30-second process deadline and the complete job a three-minute deadline.
- Each process receives one explicitly selected resolver in an existing private temporary file. The file remains present until the process closes. Numeric link-local scope and custom port are retained.
- Every relevant upstream option is explicit, including `--disable-adaptive-timeout`, both IP selectors, custom list and JSON output. This prevents the user's existing `~/.dns-bench/config.toml` from altering the comparison. NEO does not overwrite or delete that configuration; changing `HOME` alone would not isolate it on Windows.
- Processes use direct argument arrays and no shell. Both output streams count towards a 64 KiB cap. Only the exact known `Using custom servers list.` prefix is stripped before JSON parsing. Exact fields, resolver identity, request counts, percentage arithmetic, answer family and tagged Rust duration values are validated. Raw stderr and process errors are not saved.
- Completed cells publish incrementally. Cancellation/deadlines kill owned processes and await closure before releasing the job slot or deleting inputs. Unconfirmed cleanup disables further collection until restart. Partial reports survive cancellation, shutdown and restart.
- Jobs share existing capacity, idempotency, cancellation and SQLite history. Benchmark JSON uses schema 3 without migration or data deletion. Inventory assets are not created by benchmark results.

API: `GET /api/v1/dns-benchmark/options`; `POST /api/v1/dns-benchmark/preview`; `POST /api/v1/dns-benchmark/jobs` with explicit confirmation. Existing job/snapshot/cancel routes carry results. Local access guards and the authenticated fixed-route remote proxy apply.

## Verification

Unit and subprocess fixtures cover IPv6-first discovery, scoped addresses, the full matrix, schema/count/identity validation, missing tools, bounded output, deadlines, cancellation, partial persistence, restart recovery and shared collection capacity. Desktop/mobile fixtures cover defaults, review invalidation, unavailable tools, reliability before latency and retained partial results.

`node scripts/dns-benchmark-smoke.mjs` uses the actual executable against controlled loopback IPv4/IPv6 UDP/TCP DNS listeners after building. It performs no public DNS queries and is part of the Windows packaging workflow. Hosted check results and the PR record distinguish executable verification from fixture tests. Real measurements from a user's network remain a separate run from that network; development checks cannot establish an optimal resolver for another computer.
