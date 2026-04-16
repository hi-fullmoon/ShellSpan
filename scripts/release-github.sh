#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/release-github.sh [options]

Options:
  --version <semver>    Set release version (sync package.json + tauri.conf.json)
  --notes <text>        Release notes text
  --draft               Create as draft release (note: /releases/latest won't point to draft)
  --skip-build          Skip `npm run tauri:build`
  -h, --help            Show this help

Environment:
  TAURI_SIGNING_PRIVATE_KEY           Updater private key content (required for signing)
  TAURI_SIGNING_PRIVATE_KEY_PATH      Fallback key path (default: ~/.tauri/termbridge-updater.key)
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  Private key password (if key is encrypted)
  GITHUB_REPOSITORY                   Override owner/repo (default: infer from git remote)
USAGE
}

VERSION=""
NOTES=""
DRAFT=0
SKIP_BUILD=0

while (($#)); do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --notes)
      NOTES="${2:-}"
      shift 2
      ;;
    --draft)
      DRAFT=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd npm
need_cmd gh
need_cmd curl

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [[ -n "$VERSION" ]]; then
  node - "$VERSION" <<'NODE'
const fs = require('fs');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  process.exit(1);
}
const pkgPath = 'package.json';
const tauriPath = 'src-tauri/tauri.conf.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
pkg.version = version;
tauri.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n');
console.log(`Version synchronized to ${version}`);
NODE
fi

read -r APP_VERSION TAURI_VERSION UPDATER_ENDPOINT < <(node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const endpoint = (tauri.plugins && tauri.plugins.updater && tauri.plugins.updater.endpoints || [])[0] || '';
console.log(`${pkg.version} ${tauri.version} ${endpoint}`);
NODE
)

if [[ "$APP_VERSION" != "$TAURI_VERSION" ]]; then
  echo "Version mismatch: package.json=$APP_VERSION, tauri.conf.json=$TAURI_VERSION" >&2
  echo "Run with --version <x.y.z> to synchronize." >&2
  exit 1
fi

TAG="v${APP_VERSION}"

infer_repo() {
  local remote
  remote="$(git config --get remote.origin.url || true)"
  if [[ -z "$remote" ]]; then
    return 1
  fi

  node - "$remote" <<'NODE'
const remote = process.argv[2] || '';
const patterns = [
  /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/,
  /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/,
];
for (const p of patterns) {
  const m = remote.match(p);
  if (m) {
    console.log(`${m[1]}/${m[2]}`);
    process.exit(0);
  }
}
process.exit(1);
NODE
}

REPO_SLUG="${GITHUB_REPOSITORY:-}"
if [[ -z "$REPO_SLUG" ]]; then
  if ! REPO_SLUG="$(infer_repo)"; then
    echo "Failed to infer GitHub repository from remote.origin.url. Set GITHUB_REPOSITORY=owner/repo" >&2
    exit 1
  fi
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/termbridge-updater.key}"
  if [[ ! -f "$KEY_PATH" ]]; then
    echo "TAURI_SIGNING_PRIVATE_KEY is not set and key file not found: $KEY_PATH" >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "[release] Building Tauri bundles..."
  npm run tauri:build
else
  echo "[release] Skipping build (--skip-build)"
fi

BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
if [[ ! -d "$BUNDLE_DIR" ]]; then
  echo "Bundle directory not found: $BUNDLE_DIR" >&2
  exit 1
fi

detect_platform() {
  local file="$1"
  local name
  name="$(basename "$file" | tr '[:upper:]' '[:lower:]')"

  if [[ "$name" == *.app.tar.gz ]]; then
    if [[ "$name" == *aarch64* || "$name" == *arm64* ]]; then
      echo "darwin-aarch64"
      return 0
    fi
    if [[ "$name" == *x86_64* || "$name" == *x64* || "$name" == *amd64* ]]; then
      echo "darwin-x86_64"
      return 0
    fi
    if [[ "$(uname -m)" == "arm64" ]]; then
      echo "darwin-aarch64"
    else
      echo "darwin-x86_64"
    fi
    return 0
  fi

  if [[ "$name" == *.appimage.tar.gz ]]; then
    if [[ "$name" == *aarch64* || "$name" == *arm64* ]]; then
      echo "linux-aarch64"
      return 0
    fi
    if [[ "$name" == *x86_64* || "$name" == *x64* || "$name" == *amd64* ]]; then
      echo "linux-x86_64"
      return 0
    fi
    echo "linux-x86_64"
    return 0
  fi

  if [[ "$name" == *.msi.zip || "$name" == *.nsis.zip || "$name" == *.exe.zip ]]; then
    if [[ "$name" == *aarch64* || "$name" == *arm64* ]]; then
      echo "windows-aarch64"
      return 0
    fi
    if [[ "$name" == *i686* || "$name" == *x86.zip ]]; then
      echo "windows-i686"
      return 0
    fi
    echo "windows-x86_64"
    return 0
  fi

  return 1
}

declare -a UPDATER_ARCHIVES=()
while IFS= read -r f; do
  UPDATER_ARCHIVES+=("$f")
done < <(find "$BUNDLE_DIR" -type f \( -name '*.app.tar.gz' -o -name '*.AppImage.tar.gz' -o -name '*.msi.zip' -o -name '*.nsis.zip' -o -name '*.exe.zip' \) | sort)

if [[ ${#UPDATER_ARCHIVES[@]} -eq 0 ]]; then
  echo "No updater archive found under: $BUNDLE_DIR" >&2
  exit 1
fi

declare -a ROWS=()
for archive in "${UPDATER_ARCHIVES[@]}"; do
  sig_file="${archive}.sig"
  if [[ ! -f "$sig_file" ]]; then
    echo "Missing signature for updater archive: $sig_file" >&2
    echo "Check TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD." >&2
    exit 1
  fi

  if ! platform="$(detect_platform "$archive")"; then
    echo "Skipping unknown updater archive type: $archive"
    continue
  fi

  sig="$(tr -d '\r\n' < "$sig_file")"
  url="https://github.com/${REPO_SLUG}/releases/download/${TAG}/$(basename "$archive")"
  ROWS+=("${platform}|${url}|${sig}")
done

if [[ ${#ROWS[@]} -eq 0 ]]; then
  echo "No valid platform entries were generated for latest.json" >&2
  exit 1
fi

LATEST_JSON="$BUNDLE_DIR/latest.json"
node - "$LATEST_JSON" "$TAG" "$NOTES" "${ROWS[@]}" <<'NODE'
const fs = require('fs');

const out = process.argv[2];
const tag = process.argv[3];
const notesArg = process.argv[4] || '';
const rows = process.argv.slice(5);

const payload = {
  version: tag,
  notes: notesArg || `Release ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {},
};

for (const row of rows) {
  const [platform, url, signature] = row.split('|');
  payload.platforms[platform] = { signature, url };
}

fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
console.log(`Generated ${out}`);
NODE

declare -a ASSETS=()
ASSETS+=("$LATEST_JSON")
for archive in "${UPDATER_ARCHIVES[@]}"; do
  ASSETS+=("$archive" "${archive}.sig")
done
while IFS= read -r f; do
  ASSETS+=("$f")
done < <(find "$BUNDLE_DIR" -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*.exe' -o -name '*.deb' -o -name '*.AppImage' \) | sort)

# de-duplicate asset list
if ((${#ASSETS[@]} == 0)); then
  echo "No assets to upload." >&2
  exit 1
fi

ASSETS_FILE="$(mktemp)"
for a in "${ASSETS[@]}"; do
  if [[ -f "$a" ]]; then
    printf '%s\n' "$a" >> "$ASSETS_FILE"
  fi
done

UNIQUE_ASSETS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && UNIQUE_ASSETS+=("$line")
done < <(sort -u "$ASSETS_FILE")
rm -f "$ASSETS_FILE"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "[release] Release $TAG exists. Uploading assets with --clobber..."
  gh release upload "$TAG" "${UNIQUE_ASSETS[@]}" --clobber
else
  echo "[release] Creating release $TAG ..."
  args=(release create "$TAG" "${UNIQUE_ASSETS[@]}" --title "TermBridge ${TAG}")
  if [[ "$DRAFT" -eq 1 ]]; then
    args+=(--draft)
  fi
  if [[ -n "$NOTES" ]]; then
    args+=(--notes "$NOTES")
  else
    args+=(--generate-notes)
  fi
  gh "${args[@]}"
fi

if [[ "$DRAFT" -eq 1 ]]; then
  echo "[release] Draft release created. /releases/latest endpoint won't include drafts."
  exit 0
fi

if [[ -z "$UPDATER_ENDPOINT" ]]; then
  UPDATER_ENDPOINT="https://github.com/${REPO_SLUG}/releases/latest/download/latest.json"
fi

echo "[release] Verifying updater endpoint: $UPDATER_ENDPOINT"
OK=0
for _ in {1..12}; do
  if body="$(curl -fsSL "$UPDATER_ENDPOINT" 2>/dev/null)"; then
    if node -e 'JSON.parse(process.argv[1]);' "$body" >/dev/null 2>&1; then
      OK=1
      break
    fi
  fi
  sleep 3
done

if [[ "$OK" -eq 1 ]]; then
  echo "[release] Success. Updater latest.json is reachable and valid JSON."
else
  echo "[release] Uploaded, but endpoint validation failed." >&2
  echo "Run manually: curl -fsSL $UPDATER_ENDPOINT | jq ." >&2
  exit 1
fi
