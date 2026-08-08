#!/usr/bin/env bash
set -euo pipefail

CURRENT=$(node -p "require('./package.json').version")

echo "当前版本: $CURRENT"
echo ""
echo "选择升级类型:"
echo "  1) patch"
echo "  2) minor"
echo "  3) major"
echo "  4) 手动输入版本号"
echo ""
read -rp "输入数字 (1/2/3/4): " CHOICE

case "$CHOICE" in
  1) BUMP="patch" ;;
  2) BUMP="minor" ;;
  3) BUMP="major" ;;
  4)
    read -rp "输入版本号 (格式 x.y.z，可带预发布/构建后缀): " MANUAL_VERSION
    # 严格 semver（semver.org 官方正则）：纯数字标识符不允许前导零（test.1 合法，test.01 非法）
    if ! echo "$MANUAL_VERSION" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'; then
      echo "无效版本号，需符合严格 semver 格式（如 2.0.7 或 2.0.7-test.1；纯数字标识符不允许前导零，test.01 非法）"
      exit 1
    fi
    NEW="$MANUAL_VERSION"
    ;;
  *) echo "无效选择"; exit 1 ;;
esac

if [[ "$CHOICE" != "4" ]]; then
  NEW=$(node -e '
    const [current, bump] = process.argv.slice(1);
    const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) {
      console.error(`当前版本不是有效的 semver: ${current}`);
      process.exit(1);
    }
    const [, major, minor, patch] = match.map(Number);
    if (bump === "patch") console.log(`${major}.${minor}.${patch + 1}`);
    else if (bump === "minor") console.log(`${major}.${minor + 1}.0`);
    else console.log(`${major + 1}.0.0`);
  ' "$CURRENT" "$BUMP")
fi

echo ""
echo "新版本: $NEW"
read -rp "确认? (y/N): " CONFIRM

if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "已取消"
  exit 0
fi

# 更新 package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 更新 Cargo.toml
node -e "
  const fs = require('fs');
  let content = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
  content = content.replace(/^version = \".*\"/m, 'version = \"$NEW\"');
  fs.writeFileSync('src-tauri/Cargo.toml', content);
"

# 更新 tauri.conf.json
node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  conf.version = '$NEW';
  fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');
"

# 让 Cargo 根据更新后的 Cargo.toml 同步 Cargo.lock
cargo check --manifest-path src-tauri/Cargo.toml

# 生成 CHANGELOG.md
# 只保留 v2.0.0 及之后的版本，然后将新版本条目插入文件头部
if command -v git-cliff >/dev/null 2>&1; then
	if [[ -f CHANGELOG.md ]]; then
		CHANGELOG_TMP=$(mktemp)
		awk '
			keep_from_v2 && /^## \[/ { exit }
			{ lines[++count] = $0; if ($0 !~ /^[[:space:]]*$/) last = count }
			/^## \[v2\.0\.0\]/ { keep_from_v2 = 1 }
			END { for (i = 1; i <= last; i++) print lines[i] }
		' CHANGELOG.md > "$CHANGELOG_TMP"
		mv "$CHANGELOG_TMP" CHANGELOG.md
	fi
	# --prepend 会保留唯一的文件头，并把新版本放在现有记录之前
	git-cliff --unreleased --tag "v$NEW" --prepend CHANGELOG.md
else
	echo "  [skip] git-cliff not found, CHANGELOG.md not updated"
fi

# 提交 + tag + 推送
git add -A
git commit -m "chore(release): bump version to $NEW"
git tag -a "v$NEW" -m "Release v$NEW"
git push origin main --follow-tags

echo ""
echo "完成! v$NEW 已发布"
