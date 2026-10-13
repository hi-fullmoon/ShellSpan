# Real SSH cancellation regression

Run from the repository:

```bash
pnpm test:sftp-cancellation:ssh
```

Requires Node and pnpm versions from `package.json`, Docker with Linux containers,
Rust/Tauri build prerequisites, an active desktop session, and an unlocked system
keychain. The runner supports macOS and Linux desktops; macOS is the verified
platform. It builds its isolated OpenSSH image and native debug executable, so a
pre-existing test container or debug binary is not required.

The runner binds SSH to a random loopback-only port, verifies the host fingerprint
against the server's `ssh-keygen` output, and creates a temporary trust entry in the
development database. A random test password stays in memory and is never written
to the evidence or configuration files. Existing connections, credentials, and
host-trust entries are not changed.

The native window uses the production `TransferProgress`, `useSftpConnection`,
`useTransferListeners`, transfer store, and shared path scheduler. It verifies:

- Upload cancellation after real byte progress, followed by two queued uploads.
- Download cancellation after real byte progress, followed by two queued downloads.
- The old cancel control is detached when its SSH task finishes. Activating that
  stale reference cannot cancel the successor, which transfers fully.
- Queue successors start only after the preceding hook's backend call settles.
- All completed uploads and downloads have matching SHA-256 checksums; a cancelled
  upload leaves neither a final destination nor an upload temporary file.

Input files are copies of the actual debug executable, `package.json`, and
`src-tauri/Cargo.lock`; transfer progress and replies are never fabricated. The
native pointer-release gesture itself is covered by
`transfer-queue-layout.test.tsx`; this runner verifies the stale-control boundary
with actual SSH completion. It exercises the shared path queue, rather than the
SFTP page's drag-and-drop batch admission, which has its own upload-queue tests.

Each run saves timestamps, operation states, byte counters, fingerprints,
checksums, and cleanup results in `.sftp-cancellation/<run-id>/result.json`. The
directory is ignored by Git. Generated input/download directories are moved to
the system trash through the project's existing trash command after verification.
The native window removes its temporary host trust and disconnects SFTP; the
runner stops its own native process and removes only its uniquely named container.

Ctrl-C requests cancellation through the native window before shutdown. Failures,
timeouts, and cleanup failures produce a nonzero exit code with the evidence
location. If the desktop process cannot respond, inspect that record for the
remaining temporary host/port and cleanup errors before rerunning; the runner
does not overwrite an existing trusted host identity.
