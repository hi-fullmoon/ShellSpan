#!/usr/bin/env bash
set -euo pipefail

mkdir -p /linux-workspace
tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./src-tauri/target' \
  -C /workspace -cf - . | tar -C /linux-workspace -xf -
cd /linux-workspace
export CARGO_TARGET_DIR=/cargo-target

echo "linux_container_identity"
id
uname -a
sed -n '1,8p' /etc/os-release
rustc --version --verbose
cargo --version
bash --version | sed -n '1p'
zsh --version

run_transport_benchmarks() {
  cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
    --example terminal_transport_baseline -- \
    --bytes 2097152 --repetitions 5 --sessions 4
  cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
    --example terminal_transport_baseline -- \
    --bytes 2097152 --repetitions 5 --sessions 4 --broker
}

if [[ "${SHELLSPAN_LINUX_ACCEPTANCE_MODE:-full}" == "benchmark-only" ]]; then
  echo "linux_container_benchmark_round_1"
  run_transport_benchmarks
  echo "linux_container_benchmark_round_2"
  run_transport_benchmarks
  exit 0
fi

if [[ "${SHELLSPAN_LINUX_ACCEPTANCE_MODE:-full}" == "phase3-only" ]]; then
  cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
  cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    terminal_broker::tests --lib -- --nocapture
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    terminal_integration::tests --lib -- --nocapture
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    agent_runtime::native::terminal_execute::tests --lib -- --nocapture
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    agent_runtime::native::process::tests --lib -- --nocapture
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
    agent_runtime::recovery::tests --lib -- --nocapture
  exit 0
fi

cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets

cargo test --locked --manifest-path src-tauri/Cargo.toml \
  terminal_broker::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  terminal_integration::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::native::terminal_execute::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::native::terminal_lease::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::native::process::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::native::pty::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::recovery::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  commands::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  session::tests --lib -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml

echo "linux_container_benchmark_round_1"
run_transport_benchmarks
echo "linux_container_benchmark_round_2"
run_transport_benchmarks
