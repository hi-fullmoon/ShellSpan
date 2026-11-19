#!/bin/zsh
set -euo pipefail

preview_package="${0:A:h}"
preview_runtime="$(<"$preview_package/runtime-directory.txt")"
preview_store="$(<"$preview_package/webkit-store.txt")"
preview_root="${HOME:A}/.shellspan/agent-sandbox"
if [[ "${preview_runtime:h}" != "$preview_root" ||
      "${preview_runtime:t}" != preview-* ||
      "$preview_runtime" != "${preview_runtime:A}" || ! -d "$preview_runtime" ||
      ! -O "$preview_runtime" || ! -O "$preview_root" ]]; then
  print -u2 "The managed preview directory is missing or has moved."
  exit 1
fi

for preview_child in home data temporary signals app-directories; do
  preview_path="$preview_runtime/$preview_child"
  if [[ ! -e "$preview_path" && ! -L "$preview_path" ]]; then
    /bin/mkdir -m 700 "$preview_path"
  fi
  if [[ ! -d "$preview_path" || ! -O "$preview_path" || -L "$preview_path" ]]; then
    print -u2 "The managed preview path is invalid: $preview_child"
    exit 1
  fi
done

preview_manifest="$preview_runtime/launcher.json"
if [[ ! -e "$preview_manifest" && ! -L "$preview_manifest" ]]; then
  preview_probe="$preview_package/ShellSpan Sandbox Preview.app/Contents/Resources/acceptance/nono-probe"
  preview_expected_checksum="$(/usr/bin/plutil -extract launcherSha256 raw -o - "$preview_package/preview-report.json")"
  preview_checksum="$(/usr/bin/shasum -a 256 "$preview_probe")"
  if [[ "${preview_checksum%% *}" != "$preview_expected_checksum" ]]; then
    print -u2 "The bundled preview launcher does not match the build report."
    exit 1
  fi
  (
    umask 077
    set -o noclobber
    printf '{"sha256":"%s"}\n' "$preview_expected_checksum" > "$preview_manifest"
  )
fi
if [[ ! -f "$preview_manifest" || ! -O "$preview_manifest" || -L "$preview_manifest" ]]; then
  print -u2 "The managed preview launcher manifest is invalid."
  exit 1
fi
if [[ "${1:-}" == --repair-runtime ]]; then
  exit 0
fi

cd "$preview_runtime"
exec /usr/bin/env \
  TMPDIR="$preview_runtime/temporary" \
  SHELLSPAN_DATA_DIR="$preview_runtime/data" \
  SHELLSPAN_LOCAL_HOME="$preview_runtime/home" \
  SHELLSPAN_ALLOW_FOREGROUND_TESTS=1 \
  SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR="$preview_runtime" \
  SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST="$preview_manifest" \
  SHELLSPAN_ACCEPTANCE_RAW_PTY=1 \
  SHELLSPAN_ACCEPTANCE_SUBMISSION=1 \
  SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO=local-sandbox-preview \
  SHELLSPAN_ACCEPTANCE_WEBKIT_STORE="$preview_store" \
  "$preview_package/ShellSpan Sandbox Preview.app/Contents/MacOS/ShellSpan" "$@" \
  >>"$preview_package/preview.log" 2>&1
