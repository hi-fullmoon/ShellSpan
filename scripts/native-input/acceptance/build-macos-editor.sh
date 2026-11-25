#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

# The private Zsh main/Core digests were recorded with Xcode 27.2 and the 27.2 SDK.
for developer in /Applications/Xcode_27.2.app/Contents/Developer /Applications/Xcode_27.2.0.app/Contents/Developer; do
  if [[ -d "$developer" ]]; then
    export DEVELOPER_DIR="$developer"
    break
  fi
done

if [[ -z "${SDKROOT:-}" ]]; then
  for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX27.2.sdk \
    /Applications/Xcode_27.2.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.2.sdk \
    /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.2.sdk \
    /Applications/Xcode_27*.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.2.sdk; do
    if [[ -r "$sdk/SDKSettings.json" ]]; then
      SDKROOT="$sdk"
      break
    fi
  done
fi

if [[ -z "${SDKROOT:-}" || ! -r "$SDKROOT/SDKSettings.json" ]] ||
  [[ "$(/usr/bin/plutil -extract Version raw "$SDKROOT/SDKSettings.json")" != 27.2 ]]; then
  echo 'The pinned macOS ZLE build requires SDKROOT pointing to the macOS 27.2 SDK.' >&2
  exit 1
fi
export SDKROOT

xcodebuild -version
printf 'SDKROOT=%s\n' "$SDKROOT"
node scripts/native-input/acceptance/build.mjs --build-scoped-core
