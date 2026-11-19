#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/source"
tar --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
    --exclude='./artifacts' --exclude='./src-tauri/target' \
    --exclude='./scripts/agent-sandbox-phase1/target' \
    -C /workspace -cf - . | tar -C "$HOME/source" -xf -
cd "$HOME/source"

export CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export SHELLSPAN_ACCEPTANCE_NONO=/usr/local/bin/shellspan-sandbox-probe
export SHELLSPAN_ACCEPTANCE_NODE=/usr/local/bin/node
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
    linux_direct_sandbox_acceptance -- --ignored --nocapture
exec cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
    agent_runtime::native::process::tests
