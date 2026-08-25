# SFTP performance baseline

TermBridge records one `sftp_transfer_metrics` info log when an upload,
download, or remote-copy batch finishes or exits with an error. It does not log
connection credentials, host names, or transfer paths, and it adds no per-chunk
logging to the transfer loop.

The record contains:

- `connect_us`: dedicated SSH/SFTP connection establishment.
- `scan_us`: destination preparation, conflict discovery, and recursive source
  inventory performed before data transfer.
- `transfer_us`: file/directory transfer work. Per-file flush, verification, and
  atomic rename remain part of this phase because they happen inside each file
  task.
- `finalize_us`: final batch progress emission and result finalization.
- `total_us`, `total_bytes`, `file_count`, and
  `throughput_bytes_per_second`. Throughput is end-to-end bytes divided by
  `total_us`, so connection and scan costs are represented in the result.

The legacy same-connection paste path discovers recursive inventory while it
copies; its `scan_us` therefore covers destination/source setup, while recursive
discovery is included in `transfer_us`. Counters are accumulated during that
walk without a second remote scan.

## Reproduce the benchmark

Docker must be running. From the repository root on Windows:

```powershell
pwsh -File scripts/run-sftp-benchmark.ps1
```

The script reuses `tests/ssh-e2e`, builds the Rust test in release mode, runs
three iterations, validates every metric field, verifies downloaded byte/file
inventory, prints one `SFTP_BENCHMARK` line per operation, and removes its
container and volume afterward. Defaults cover:

- one 16 MiB file;
- one directory containing 128 files of 4 KiB each.

For a fast environment/integrity check without waiting for the first release
build, pass `-DebugBuild`. Treat those numbers as a separate debug baseline;
do not compare them with release results.

Workload sizes and repetitions can be pinned explicitly:

```powershell
pwsh -File scripts/run-sftp-benchmark.ps1 `
  -Iterations 5 `
  -LargeBytes 67108864 `
  -SmallFileCount 1000 `
  -SmallFileBytes 4096
```

Compare medians from identical workload parameters on the same machine. The
test deliberately does not assert an absolute speed because Docker, filesystem,
and CI runner contention make such thresholds unstable; it asserts metric
completeness and transfer integrity instead.
