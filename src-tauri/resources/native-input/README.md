# Native Bash resources

`pnpm native:prepare` builds the host's accepted GNU Bash targets and stages
verified resources in `generated/`. `--with-ssh` also builds the Linux aarch64
glibc 2.36 targets in the pinned Docker environment. CI imports that target's
source-verified artifact before staging the macOS application.

Generated binaries are excluded from Git. The Tauri resource map preserves
`native-input/generated/` in the final bundle; release loading uses that
directory. Source, GNU archives/patches, Rust vendor sources and notices accompany
the resources. The application verifies the bound user shell and module hashes;
it does not replace the user's shell with the packaged GNU binary.
