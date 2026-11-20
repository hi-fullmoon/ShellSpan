#!/usr/bin/env bash
set -euo pipefail

dmg=$1
bytes_per_mib=$((1024 * 1024))
size_warning_mib=100
overhead_warning_mib=8

size_bytes=$(/usr/bin/stat -f '%z' "$dmg")
printf 'macOS DMG size: %s bytes\n' "$size_bytes"
if (( size_bytes > size_warning_mib * bytes_per_mib )); then
  printf '::warning title=macOS DMG size::DMG is %s bytes, above the %s MiB warning threshold.\n' "$size_bytes" "$size_warning_mib"
fi

if ! overhead_bytes=$(/usr/bin/hdiutil imageinfo -plist "$dmg" |
  /usr/bin/plutil -extract 'Size Information.CUDIFEncoding-bytes-wasted' raw -expect integer -o - -) ||
  (( overhead_bytes < 0 )); then
  printf '::warning title=macOS DMG encoding overhead::Could not read the wasted encoding bytes.\n'
  exit 0
fi

printf 'macOS DMG encoding overhead: %s bytes\n' "$overhead_bytes"
if (( overhead_bytes > overhead_warning_mib * bytes_per_mib )); then
  printf '::warning title=macOS DMG encoding overhead::DMG contains %s wasted encoding bytes, above the %s MiB warning threshold.\n' "$overhead_bytes" "$overhead_warning_mib"
fi
