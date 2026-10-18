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

## Optional automatic endpoint discovery

Discovery offers an initially unchecked **Read existing Glances REST stats automatically** option. Select HTTP or verified HTTPS and approve link-wide transmission, then review and confirm the complete job. This consent includes bounded mDNS endpoint resolution and subsequent fixed-path stats reads; ordinary discovery never adds these reads automatically.

Glances uses _glances._tcp for both REST and XML-RPC. The resolver requires a matching PTR instance, an unambiguous SRV port, exact protocol=rest TXT bytes, and an A record matching the already approved responding address. RPC, unknown protocol, conflicting, withdrawn, expired, mismatched and unresolved advertisements are skipped. Advertised paths and URLs are ignored. DNS label bytes and label boundaries are preserved during matching; TXT keys are ASCII case-insensitive and the first occurrence wins, including missing/empty values.

The resolver sends at most seven fixed multicast questions over an eight-second resolution window. At most two endpoints are read, with six sequential requests each and at most two endpoint tasks. Each HTTP read retains the manual transport's limits. Results remain snapshots, with explicit skipped/partial/failed outcomes in Activity. This work shares the discovery job's cancellation, deadline and collection slot; base discovery evidence survives cancellation or failed enrichment. Source/interface and scope are revalidated before resolution and reads. No installation, credential attempts, recurring polling or scope expansion occurs.

## Verification and sources

Tests use isolated loopback HTTP fixtures and explicit injected API/UDP seams; no private topology, credentials or physical Glances installation is used in CI. The production smoke exercises the actual compiled transport. Browser tests exercise manual and combined discovery consent, repeated-click prevention, partial values and responsive presentation. Windows unit verification includes real loopback transports and shutdown preservation; physical Glances interoperability remains unverified.

Official contracts reviewed: [Glances REST API](https://glances.readthedocs.io/en/latest/api/restful.html), [v4.5.8 REST implementation](https://github.com/nicolargo/glances/blob/v4.5.8/glances/outputs/glances_restful_api.py), [system plugin](https://github.com/nicolargo/glances/blob/v4.5.8/glances/plugins/system/__init__.py), [filesystem plugin](https://github.com/nicolargo/glances/blob/v4.5.8/glances/plugins/fs/__init__.py), [dynamic advertisement](https://github.com/nicolargo/glances/blob/v4.5.8/glances/servers_list_dynamic.py).


## Windows update and database backup

Schema v2 is additive and applied in one SQLite transaction. Existing observations/jobs are retained. A schema-v1 binary refuses the upgraded database, so save the pre-update database if rollback may be needed. Migration failure rolls back rather than committing a partial version change.

Stop Neo with Ctrl+C and wait for the terminal prompt. Stop every other Neo process using the same database. Do not copy a database while its writer is running, and do not delete WAL/SHM files. In PowerShell, from the same repository directory and environment used to launch Neo:

~~~powershell
$ErrorActionPreference = 'Stop'
$db = if ($env:NEO_DB_PATH) { [IO.Path]::GetFullPath($env:NEO_DB_PATH) } else { Join-Path (Get-Location).Path 'data\neo.sqlite' }
if (!(Test-Path -LiteralPath $db -PathType Leaf)) { throw "Database not found: $db" }
$backup = Join-Path (Split-Path -Parent $db) ('neo-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
foreach ($suffix in @('', '-wal', '-shm')) {
  $source = $db + $suffix
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    $destination = Join-Path $backup ([IO.Path]::GetFileName($source))
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Backup verification failed' }
  }
}
git rev-parse HEAD | Set-Content -LiteralPath (Join-Path $backup 'source-commit.txt')
Write-Host "Verified stopped-database backup: $backup"
~~~

The default path is data\neo.sqlite relative to Neo's launch directory. NEO_DB_PATH overrides it; a relative override is also resolved from that directory. Clean shutdown normally checkpoints/removes sidecars. The script copies any remaining -wal/-shm together with the main file into a new unique directory and verifies bytes; never overwrite or omit a remaining WAL.

Then update using git pull --ff-only origin feat/initial-foundation, npm.cmd ci, npm.cmd run build and npm.cmd start. Check the visible home-support-v6 marker.

For rollback, stop Neo again. Preserve the upgraded database separately. Use the saved source commit in a separate checkout and a fresh copy of the entire backup file set in a new directory; set NEO_DB_PATH to that restored main file before starting the old build. Do not overwrite the only backup, combine old/new sidecars, or point the old binary at the upgraded database. The backup restores only the information present at backup time; subsequent scans/snapshots remain in the preserved upgraded copy.
