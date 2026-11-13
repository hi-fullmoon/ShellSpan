#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
build_dir="${SHELLSPAN_NATIVE_BUILD_ROOT:-src-tauri/target/native-input}/native-input-p3"
archive="$build_dir/dependencies/zsh-5.9.tar.xz"
if [ ! -f "$archive" ]; then
    mkdir -p "$(dirname "$archive")"
    curl --fail --location --proto '=https' --tlsv1.2 https://www.zsh.org/pub/old/zsh-5.9.tar.xz -o "$archive"
fi
printf '%s  %s\n' 9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5 "$archive" | sha256sum -c -
node -p 'JSON.stringify({node:process.version,architecture:process.arch,platform:process.platform})' > "$build_dir/linux-tools.json"
node scripts/native-input-p3/build-scoped-core.mjs "$archive" > "$build_dir/linux-core-build.json"
p3_core_source=$(python3 -c 'import json,pathlib,sys; record=json.loads(pathlib.Path(sys.argv[1]).read_text()); producer=json.loads((pathlib.Path(record["directory"])/"producer.json").read_text()); print(producer["source"])' "$build_dir/linux-core-build.json")
cc -std=c11 -I "$p3_core_source" scripts/native-input-p3/zsh-build-check.c -o "$build_dir/zsh-build-check-linux"
"$p3_core_source/Src/zsh" -f -c 'value=$(/usr/bin/printf %s P3_CONFIG); [[ $value == P3_CONFIG ]]'
export CARGO_TARGET_DIR="$(cd "$build_dir" && pwd)/linux-target"
cargo build --locked --release --manifest-path src-tauri/native-input-editors/Cargo.toml --lib
cc -std=c11 -DMODULE -fPIC -shared -Wl,--exclude-libs,ALL -I "$p3_core_source/Src" \
    src-tauri/native-input-editors/zle.c "$CARGO_TARGET_DIR/release/libshellspan_native_input_editors.a" \
    -lpthread -ldl -lm -o "$build_dir/ss_nip-linux.so"
cargo build --locked --release --manifest-path src-tauri/native-input-adapter/Cargo.toml --bin native-input-relay
python3 scripts/native-input-p3/publish-linux.py
