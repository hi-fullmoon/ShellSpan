#!/bin/sh
set -eu
mkdir -p /tmp/home /cache/cargo
tar -C /opt/app --exclude='./node_modules' --exclude='./.compat-pnpm-store' -cf - . | tar -C /workspace -xf -
cp -a /opt/cargo/registry /cache/cargo/
cp -a /opt/app/.compat-pnpm-store /cache/pnpm-store
cd /workspace
pnpm install --offline --frozen-lockfile --store-dir /cache/pnpm-store
pnpm build
pnpm test --reporter=dot --silent
cargo build --locked --offline --manifest-path src-tauri/Cargo.toml
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- \
  --skip operator_workspace \
  --skip operator_direct_execution_can_write_outside_its_working_directory \
  --quiet
