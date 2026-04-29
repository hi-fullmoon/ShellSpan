#!/usr/bin/env bash
set -euo pipefail

CURRENT=$(node -p "require('./package.json').version")

echo "当前版本: $CURRENT"
echo ""
echo "选择升级类型:"
echo "  1) patch"
echo "  2) minor"
echo "  3) major"
echo ""
read -rp "输入数字 (1/2/3): " CHOICE

case "$CHOICE" in
  1) BUMP="patch" ;;
  2) BUMP="minor" ;;
  3) BUMP="major" ;;
  *) echo "无效选择"; exit 1 ;;
esac

NEW=$(node -p "
  const [m, n, p] = '$CURRENT'.split('.').map(Number);
  if ('$BUMP' === 'patch') return \`\${m}.\${n}.\${p + 1}\`;
  if ('$BUMP' === 'minor') return \`\${m}.\${n + 1}.0\`;
  if ('$BUMP' === 'major') return \`\${m + 1}.0.0\`;
")

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

# 提交 + tag + 推送
git add -A
git commit -m "chore(release): bump version to $NEW"
git tag -a "v$NEW" -m "Release v$NEW"
git push origin main --follow-tags

echo ""
echo "完成! v$NEW 已发布"
