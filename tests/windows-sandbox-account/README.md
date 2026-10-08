# Stage A account sandbox prototype

Independent Windows-only experiment. It does not import the existing PSEC probes,
install a driver, register production IPC, or change the production unavailable gate.
Only newly created private fixtures are accepted; user project paths and commands
are not inputs. The crate uses the repository's Windows API and UUID versions.

```powershell
cargo test --locked --manifest-path tests/windows-sandbox-account/Cargo.toml
cargo clippy --locked --manifest-path tests/windows-sandbox-account/Cargo.toml --all-targets -- -D warnings
./tests/windows-sandbox-account/run.ps1
# Explicit machine setup action, presents UAC:
./tests/windows-sandbox-account/run.ps1 -RunOwnedFixture
```

Default execution only checks elevation and exits 2 (NO-GO). Unit tests use real
CreateRestrictedToken and AccessCheck on in-memory Windows security descriptors,
without changing system accounts or disk ACLs. They show both SID passes are needed,
Everyone is insufficient, and explicit deny takes precedence. This is limited
evidence from the current account, not dedicated-account acceptance.

The explicit elevated fixture action creates an unpredictable disabled local user
and a protected new NTFS ProgramData fixture (SYSTEM/Administrators only), writes
planned account and exact WFP GUID ownership before mutation, resolves its SID,
installs four persistent SID blocks at IPv4/IPv6 ALE connect and receive/accept
layers in a WFP transaction, temporarily enables the account to log on, disables it
immediately, and derives a token with a single call-specific restricting SID and
DISABLE_MAX_PRIVILEGE. Its random password is used in memory only and its UTF-16
buffer is wiped; it is never serialized, passed in argv/environment, or reused.
This is not the reusable credential reference required for the phase B account pool.

The experiment merges non-inheriting ACEs for ordinary account and restricting SIDs
on each fixture object. It retains the original owner and DACL. It never grants
DELETE_CHILD or WRITE_DAC/WRITE_OWNER. Ancestors of secrets are pinned without DELETE.
Ordinary files/directories may receive DELETE in workspace mode. Existing secrets
receive no access, root .env.local and .git receive read access. File opens run under
restricted-token impersonation. Build artifact creation/reopen is checked separately:
new-object/default-DACL behavior must succeed in reality, not be inferred from
existing-file writes. No grants are recursively inherited onto future secrets.

TCP/UDP IPv4/IPv6 loopback tests first prove host receiver reachability, then record
both sandbox API outcome and receiver outcome. These test sockets created on an
impersonated thread; **they do not prove restricted child-process networking**.
They omit inbound sandbox listeners, private LAN, DNS/service delegation and alternate
executables. No public destination or third-party receiver is contacted.

## Ownership and cleanup

Every normal/error return after account creation disables it, attempts incremental
revocation of the exact fixture SIDs, and removes the owned account before removing
its exact WFP filters. Uncertain ACL cleanup retains the disabled account and offline
filters. The protected ownership.json records checks and cleanup debts. The fixture
is retained for review; no local file is irreversibly deleted. Retire it via the
project's recycle-bin mechanism after evidence review.

This receipt is a fixture-only prototype, not a crash-safe production journal:
partial account creation, aborted filter transactions, crashes during activation,
replaced objects, concurrent administrative DACL edits, or receipt I/O failures can
need manual recovery. Do not infer ownership from a prefix or delete accounts/filters
in bulk. For an interrupted run, an administrator must verify the protected receipt,
match the **account SID** (not just its name), disable that account, prove no associated
processes exist, inspect each exact filter key/condition, and revoke only its exact
fixture ACEs. Retain offline rules until process absence and account removal are
confirmed. Phase B must implement authenticated fixed recovery operations, object
identities and durable per-mutation receipts before production reuse.

## Acceptance boundary

The action always returns NO-GO while mandatory phase A evidence is missing. Neither
unit-test success nor the elevated fixture results authorize stage B. Restricted
primary-token process launch, private desktop, system/toolchain startup ACLs, token
default DACL, sensitive handle access, hardlink/reparse/ADS/short-name cases, dynamic
snapshot refresh, and full receiver-backed networking must still be implemented and
validated. Do not run on a managed enterprise machine without its approved settings
process; policy conflicts are failures, not grounds for relaxing rules.

API references: [restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens),
[WFP condition identifiers](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-).
