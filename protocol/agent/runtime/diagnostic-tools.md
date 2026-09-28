# Structured diagnostic tools (phase one)

The native registry exposes `inspect_host`, `inspect_service`, `query_logs` and
`diagnose_endpoint` on local POSIX and credential-backed SSH targets. They do not
require a project root. The existing frozen-target validation, native capability
approval, effect admission, process cancellation and durable evidence path apply.
Diagnostic read tools retain `sensitiveRead`; endpoint requests retain
`externalSideEffect` with the exact protocol/host/port in policy scope. No tool
installs dependencies, escalates privilege, mutates a service or grants a skill
additional permission. Read-role children can inherit only the three reads;
endpoint probes require an operator/general scope and parent authorization.

## Transport and environment

An application-owned Python collector is compiled into the Rust binary and run
with `python3 -I`. Arguments are serialized JSON encoded as a separate base64
argument, never interpolated as executable source. Local dispatch uses argv
directly without a login shell; SSH uses the existing authenticated exec channel.
All collector subprocesses use
argument vectors with `shell=False`; service names prohibit options/patterns.
Standard-library JSON, HTTP, URL/IP, TLS and certificate parsers are used.
The target needs Python 3.8+ with SSL. Local Windows and non-systemd service/log
inspection return explicit availability errors. Missing dependencies are not
silently installed or replaced with guessed observations.

The collector has a 100–30000 ms deadline (default 10000), including DNS, socket
operations and child commands. Local transport allows two seconds for final
result collection. Remote diagnostics use one native deadline across DNS, TCP,
SSH handshake, authentication, channel setup and result collection. They enter
the existing scoped connection IO boundary inside the worker thread, which closes
registered sockets on deadline/cancellation; interrupted setup is reported as
`timedOut`/`cancelled`, not a missing collector. SSH channel cancellation cannot
guarantee remote process termination; results preserve `terminationConfirmed` and
the collector's own deadline bounds remaining work. No automatic retry of endpoint
requests is permitted. At most four managed processes are admitted by this path.

Results include schema version, frozen target ID, collection time, native call
reference and start/completion time. `completed` means evidence was collected,
not that the application is healthy. Per-observation `unavailable`, endpoint
`failed`/`denied`/`notRun`, transport failure and timeout remain distinct. Data is
decoded before applying known connection-credential redaction to JSON strings
(including keys), then passed through the existing JSON redactor before leaving
the process snapshot or tool. Partial, truncated or invalid diagnostic JSON is
never exposed through a raw-text fallback. Ordinary terminal output retains its
existing text redaction path. Inputs with
recognized credential values are rejected before dispatch. Remote content,
certificate fields, messages and error text are untrusted evidence.

## Tool contracts

- `inspect_host`: optional unique `fields` selected from system/cpu/memory/disk/
  capabilities. Reports logical CPU count and load averages, physical memory,
  root filesystem capacity/inodes and installed diagnostic commands. No process
  arguments or environment dump. Available memory, application volumes and cgroup
  quotas are explicitly not inferred from these host metrics.
- `inspect_service`: one exact `service` unit. Requires a running Linux systemd
  manager. Collects selected `systemctl show --value --property=...` values,
  avoiding environment/command-line properties. Results are sequential samples,
  not an atomic state snapshot or application-health verdict.
- `query_logs`: one exact `service`, required `sinceUnixMs`/`untilUnixMs` in an
  increasing UTC interval of at most 24 hours, optional literal `keyword`,
  `maxEntries` (1–200; default 100), and opaque `cursor`. Reads systemd journal
  JSON chronologically, at most 2000 scanned records/page, with a one-record
  lookahead. Cursors bind target, unit, time window and keyword and carry the last
  scanned journal cursor. The anchor is verified before skipping it on continuation;
  removed anchors return `staleCursor`. A page can contain zero matches with a next cursor.
  Message length, entry byte budget and individual record size are bounded;
  oversized records produce an explicit collection error, never fabricated JSON.
  Paging uses streaming termination rather than recent-tail line limits, and never
  combines `--since` with a cursor, as required by the
  [systemd 252 journal implementation](https://github.com/systemd/systemd/blob/v252/src/journal/journalctl.c).
  The query covers only records visible to the OS user; retention, rotation and
  permissions prevent any guarantee of complete historical coverage. Container
  and arbitrary file logs continue through existing authorized tools.
- `diagnose_endpoint`: required ASCII `host`, explicit `port`, and `protocol`
  tcp/tls/http/https; optional HTTP origin-form `path`. Resolves once (up to 16
  addresses), rejects link-local/multicast/unspecified/reserved addresses including
  mapped IPv4, and connects using numeric socket addresses. Private and loopback
  destinations require the same explicit authorization as other destinations.
  The shared compiled `blocked-network-destinations.json` denies metadata hostnames
  before resolution and metadata IPs (including `fd00:ec2::254` and equivalent IPv6
  spellings) after resolution. Native admission uses the same connection policy;
  the collector receives the list as a private argument that model input cannot
  override.
  TLS retains the original hostname for SNI/verification and uses the target's
  default trust store. No insecure retry, client credential, proxy or redirect.
  HTTP sends HEAD on the already established connection and returns protocol
  status without a response body or cookies. Certificate details are available
  only after successful verification; revocation and complete chain inventory
  are not claimed. One successful address is sampled, not every backend.

## Skills

The bundled `deployment-preflight`, `deployment-verification` and `tls-diagnosis`
skills define evidence requirements, scope, ordered checks, interpretation and
completion criteria. Existing system/service/network/log skills prefer these
tools when available. Checks remain inconclusive when required identity,
thresholds, permissions or evidence are absent. A passed preflight never
authorizes deployment; verification never implicitly authorizes rollback.

## Verification

`pnpm test:agent-diagnostics` runs the local Python HTTP/TLS/host tests, native
diagnostic admission/cancellation tests, and a disposable Debian systemd container
with real sshd lifecycle and journal cursor tests. Docker and Python are required.
The container uses a private cgroup namespace, no host bind mounts, no published
ports and no network; it is removed in the runner's finalizer. Certificates for
local TLS tests are generated in a temporary directory and removed on completion.

The ignored Rust test `diagnostic_isolated_ssh_collects_remote_host_and_remote_loopback_http`
uses the existing explicitly opted-in SSH acceptance environment from
`tests/ssh-e2e`; it verifies the real SSH process transport and the remote HTTP
listener on port 18081. Unsupported systemd environments must return unavailable,
not a fabricated service state.
