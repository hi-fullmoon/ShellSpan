# Native Bash resources

`pnpm native:prepare` builds the supported local editor resources and stages
verified resources in `src-tauri/target/native-input/generated/` at the repository
root. Preparation logs, staging and retained prior output are in the sibling
`resource-build/` directory and are not bundled. `--with-ssh` builds Linux SSH
resources with Docker (ARM64 on glibc 2.36 and x86_64 on glibc 2.28 for macOS,
x86_64 for Windows). Release CI builds both Linux architectures
on native runners; `--require-ssh` makes the client package fail if any of its
required SSH resources are missing.

Clean Cargo/dev builds create only an empty staging directory for Tauri resource
discovery; they do not generate or admit any native profile. Isolated validation
preparation remains under `artifacts/tests/` and does not replace release input.
Ordinary development reads the prepared `src-tauri/target/native-input/generated/`
tree. Frozen acceptance runs retain their snapshot's producer tree under
`artifacts/tests/native-input/integration/resources/native-input/`; an explicitly admitted
`SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT` continues to take precedence.

Generated binaries are excluded from Git. The Tauri resource map preserves
`native-input/generated/` in the final bundle; release loading uses that
directory. Source, GNU archives/patches, Rust vendor sources and notices accompany
the resources. On macOS ARM64, selecting ShellSpan Bash in the new session dialog
launches the bundled Bash 5.3.20 / Readline 8.3.6 after verifying its catalogue
and executable SHA-256. Linux x86_64 SSH verifies the bundled Bash 5.3 / Readline 8.3.6,
adapter and relay locally and after SFTP upload. It uses that Bash only for the
new native terminal session, without modifying the account's login shell. Linux
ARM64 continues to require a digest match for the account's existing shell.
