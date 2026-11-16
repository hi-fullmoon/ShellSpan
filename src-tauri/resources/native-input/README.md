# Native Bash resources

`pnpm native:prepare` builds the supported local editor resources and stages
verified resources in `src-tauri/target/native-input/generated/` at the repository
root. Preparation logs, staging and retained prior output are in the sibling
`resource-build/` directory and are not bundled. `--with-ssh` builds the pinned
glibc 2.36 Linux SSH resources with Docker (`linux/arm64` and `linux/amd64` for
macOS; `linux/amd64` for Windows). Release CI builds both Linux architectures
on native runners; `--require-ssh` makes the client package fail if any of its
required SSH resources are missing.

Clean Cargo/dev builds create only an empty staging directory for Tauri resource
discovery; they do not generate or admit any native profile. Isolated validation
preparation remains under `.artifacts/tests/` and does not replace release input.

Generated binaries are excluded from Git. The Tauri resource map preserves
`native-input/generated/` in the final bundle; release loading uses that
directory. Source, GNU archives/patches, Rust vendor sources and notices accompany
the resources. Linux x86_64 SSH verifies the bundled Bash 5.3 / Readline 8.3.6,
adapter and relay locally and after SFTP upload. It uses that Bash only for the
new native terminal session, without modifying the account's login shell. Linux
ARM64 continues to require a digest match for the account's existing shell.
