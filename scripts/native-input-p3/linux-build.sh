#!/bin/sh
set -eu
cd /work
archive=.artifacts/tests/native-input-p3/dependencies/zsh-5.9.tar.xz
printf '%s  %s\n' 9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5 "$archive" | sha256sum -c -
node -p 'JSON.stringify({node:process.version,architecture:process.arch,platform:process.platform})' > .artifacts/tests/native-input-p3/linux-tools.json
node scripts/native-input-p3/build-scoped-core.mjs "$archive" > .artifacts/tests/native-input-p3/linux-core-build.json
p3_core_source=$(python3 -c 'import json,pathlib; record=json.loads(pathlib.Path(".artifacts/tests/native-input-p3/linux-core-build.json").read_text()); producer=json.loads((pathlib.Path(record["directory"])/"producer.json").read_text()); print(producer["source"])')
cc -std=c11 -I "$p3_core_source" scripts/native-input-p3/zsh-build-check.c -o .artifacts/tests/native-input-p3/zsh-build-check-linux
"$p3_core_source/Src/zsh" -f -c 'value=$(/usr/bin/printf %s P3_CONFIG); [[ $value == P3_CONFIG ]]'
CARGO_TARGET_DIR=/work/.artifacts/tests/native-input-p3/linux-target cargo build --locked --release --manifest-path src-tauri/native-input-editors/Cargo.toml --lib
cc -std=c11 -DMODULE -fPIC -shared -Wl,--exclude-libs,ALL -I "$p3_core_source/Src" \
    src-tauri/native-input-editors/zle.c .artifacts/tests/native-input-p3/linux-target/release/libshellspan_native_input_editors.a \
    -lpthread -ldl -lm -o .artifacts/tests/native-input-p3/ss_nip-linux.so
CARGO_TARGET_DIR=/work/.artifacts/tests/native-input-p3/linux-target cargo build --locked --release --manifest-path src-tauri/native-input-adapter/Cargo.toml --bin native-input-relay
python3 scripts/native-input-p3/publish-linux.py
