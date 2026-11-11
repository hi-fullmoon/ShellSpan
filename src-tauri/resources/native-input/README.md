# Native Bash resources

`pnpm native:prepare` builds the host's Bash 5.3 / Readline 8.3.6 release profile and stages
verified resources in `.artifacts/releases/native-input/generated/` at the repository
root. Preparation logs, staging and retained prior output are in the sibling
`resource-build/` directory and are not bundled. `--with-ssh` also builds the Linux aarch64
glibc 2.36 targets in the pinned Docker environment. CI imports that target's
source-verified artifact before staging the macOS application.

Clean Cargo/dev builds create only an empty staging directory for Tauri resource
discovery; they do not generate or admit any native profile. Isolated validation
preparation remains under `.artifacts/tests/` and does not replace release input.

Generated binaries are excluded from Git. The Tauri resource map preserves
`native-input/generated/` in the final bundle; release loading uses that
directory. Source, GNU archives/patches, Rust vendor sources and notices accompany
the resources. The application verifies the bound user shell and module hashes;
it does not replace the user's shell with the packaged GNU binary.
