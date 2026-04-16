#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

Root env files:
  .env                                Optional local/shared env file
  .env.local                          Optional local-only env file, overrides .env
USAGE
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

load_env_file() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  # .env files are treated as local shell env input for release automation.
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

load_release_env() {
  load_env_file "$ROOT_DIR/.env"
  load_env_file "$ROOT_DIR/.env.local"
}

synchronize_version() {
  local version="$1"
  node - "$version" <<'NODE'
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
}

read_release_metadata() {
  node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const endpoint = (tauri.plugins && tauri.plugins.updater && tauri.plugins.updater.endpoints || [])[0] || '';
console.log(`${pkg.version} ${tauri.version} ${endpoint}`);
NODE
}

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

main() {
  cd "$ROOT_DIR"

  local version=""
  local notes=""
  local draft=0
  local skip_build=0

  while (($#)); do
    case "$1" in
      --)
        shift
        ;;
      --version)
        version="${2:-}"
        shift 2
        ;;
      --notes)
        notes="${2:-}"
        shift 2
        ;;
      --draft)
        draft=1
        shift
        ;;
      --skip-build)
        skip_build=1
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

  load_release_env

  need_cmd node
  need_cmd npm
  need_cmd gh
  need_cmd curl

  if ! gh auth status >/dev/null 2>&1; then
    echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
    exit 1
  fi

  if [[ -n "$version" ]]; then
    synchronize_version "$version"
  fi

  local app_version
  local tauri_version
  local updater_endpoint
  read -r app_version tauri_version updater_endpoint < <(read_release_metadata)

  if [[ "$app_version" != "$tauri_version" ]]; then
    echo "Version mismatch: package.json=$app_version, tauri.conf.json=$tauri_version" >&2
    echo "Run with --version <x.y.z> to synchronize." >&2
    exit 1
  fi

  local tag="v${app_version}"
  local repo_slug="${GITHUB_REPOSITORY:-}"
  if [[ -z "$repo_slug" ]]; then
    if ! repo_slug="$(infer_repo)"; then
      echo "Failed to infer GitHub repository from remote.origin.url. Set GITHUB_REPOSITORY=owner/repo" >&2
      exit 1
    fi
  fi

  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    local key_path="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/termbridge-updater.key}"
    if [[ ! -f "$key_path" ]]; then
      echo "TAURI_SIGNING_PRIVATE_KEY is not set and key file not found: $key_path" >&2
      exit 1
    fi
    export TAURI_SIGNING_PRIVATE_KEY
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_path")"
  fi

  if [[ "$skip_build" -eq 0 ]]; then
    echo "[release] Building Tauri bundles..."
    npm run tauri:build
  else
    echo "[release] Skipping build (--skip-build)"
  fi

  local bundle_dir="$ROOT_DIR/src-tauri/target/release/bundle"
  if [[ ! -d "$bundle_dir" ]]; then
    echo "Bundle directory not found: $bundle_dir" >&2
    exit 1
  fi

  local -a updater_archives=()
  while IFS= read -r f; do
    updater_archives+=("$f")
  done < <(find "$bundle_dir" -type f \( -name '*.app.tar.gz' -o -name '*.AppImage.tar.gz' -o -name '*.msi.zip' -o -name '*.nsis.zip' -o -name '*.exe.zip' \) | sort)

  if [[ ${#updater_archives[@]} -eq 0 ]]; then
    echo "No updater archive found under: $bundle_dir" >&2
    exit 1
  fi

  local -a rows=()
  local archive
  for archive in "${updater_archives[@]}"; do
    local sig_file="${archive}.sig"
    if [[ ! -f "$sig_file" ]]; then
      echo "Missing signature for updater archive: $sig_file" >&2
      echo "Check TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD." >&2
      exit 1
    fi

    local platform
    if ! platform="$(detect_platform "$archive")"; then
      echo "Skipping unknown updater archive type: $archive"
      continue
    fi

    local sig
    sig="$(tr -d '\r\n' < "$sig_file")"
    local url="https://github.com/${repo_slug}/releases/download/${tag}/$(basename "$archive")"
    rows+=("${platform}|${url}|${sig}")
  done

  if [[ ${#rows[@]} -eq 0 ]]; then
    echo "No valid platform entries were generated for latest.json" >&2
    exit 1
  fi

  local latest_json="$bundle_dir/latest.json"
  node - "$latest_json" "$tag" "$notes" "${rows[@]}" <<'NODE'
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

  local -a assets=()
  assets+=("$latest_json")
  for archive in "${updater_archives[@]}"; do
    assets+=("$archive" "${archive}.sig")
  done
  while IFS= read -r f; do
    assets+=("$f")
  done < <(find "$bundle_dir" -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*.exe' -o -name '*.deb' -o -name '*.AppImage' \) | sort)

  if ((${#assets[@]} == 0)); then
    echo "No assets to upload." >&2
    exit 1
  fi

  local assets_file
  assets_file="$(mktemp)"
  local a
  for a in "${assets[@]}"; do
    if [[ -f "$a" ]]; then
      printf '%s\n' "$a" >> "$assets_file"
    fi
  done

  local -a unique_assets=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && unique_assets+=("$line")
  done < <(sort -u "$assets_file")
  rm -f "$assets_file"

  if gh release view "$tag" >/dev/null 2>&1; then
    echo "[release] Release $tag exists. Uploading assets with --clobber..."
    gh release upload "$tag" "${unique_assets[@]}" --clobber
  else
    echo "[release] Creating release $tag ..."
    local -a args=(release create "$tag" "${unique_assets[@]}" --title "TermBridge ${tag}")
    if [[ "$draft" -eq 1 ]]; then
      args+=(--draft)
    fi
    if [[ -n "$notes" ]]; then
      args+=(--notes "$notes")
    else
      args+=(--generate-notes)
    fi
    gh "${args[@]}"
  fi

  if [[ "$draft" -eq 1 ]]; then
    echo "[release] Draft release created. /releases/latest endpoint won't include drafts."
    exit 0
  fi

  if [[ -z "$updater_endpoint" ]]; then
    updater_endpoint="https://github.com/${repo_slug}/releases/latest/download/latest.json"
  fi

  echo "[release] Verifying updater endpoint: $updater_endpoint"
  local ok=0
  local body
  for _ in {1..12}; do
    if body="$(curl -fsSL "$updater_endpoint" 2>/dev/null)"; then
      if node -e 'JSON.parse(process.argv[1]);' "$body" >/dev/null 2>&1; then
        ok=1
        break
      fi
    fi
    sleep 3
  done

  if [[ "$ok" -eq 1 ]]; then
    echo "[release] Success. Updater latest.json is reachable and valid JSON."
  else
    echo "[release] Uploaded, but endpoint validation failed." >&2
    echo "Run manually: curl -fsSL $updater_endpoint | jq ." >&2
    exit 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
