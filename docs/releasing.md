# ShellSpan 发布流程

## 准备版本

使用仓库指定的 pnpm、Node.js 和 Rust 工具链，安装依赖并登录 GitHub CLI。发布准备要求工作区干净，以及能够读取 `hi-fullmoon/ShellSpan` 的最新稳定版。

```bash
pnpm release:prepare minor
# 或指定版本，包括预发布版本
pnpm release:prepare 2.1.0-rc.1
```

不带参数的 `pnpm release:prepare` 提供交互入口。不要使用包管理器内置的 `pnpm version` 或 `npm version`；`preversion` 会在其修改版本之前拒绝执行并提示正确命令。准备命令不会创建 commit 或 tag，它会：

1. 从 GitHub Latest 获取已经公开且包含 `latest.json` 的稳定版，固定其 tag 和提交 SHA。
2. 对该提交到当前 HEAD 的完整范围生成候选说明。范围内的失败发布和预发布标签不会截断变更。
3. 同步 `package.json`、Tauri 配置、Cargo 清单及锁文件的版本；使用 Cargo 验证锁文件。
4. 创建 `release-notes/<version>.md` 和对应 `.json` 元数据。已有说明不会被覆盖。

版本文件、说明和元数据属于同一次准备操作。任何写入或 Cargo 校验失败都会恢复本次修改的版本文件，并移除本次创建的不完整说明；原有文件不会被删除。如果恢复本身失败，命令会列出需要检查的文件。

版本约定：兼容性修复用 patch，新增能力用 minor，明确的不兼容变化用 major。预发布后缀必须同步到四处版本号；不再允许只给 tag 追加测试后缀。构建元数据后缀不用于发布版本。

## 整理说明

编辑 `release-notes/<version>.md`，以用户能够理解的场景和结果描述变化：

- 同一功能的多次提交合并成一条，核对实际代码，避免把开发步骤列为功能。
- 根据需要使用 `### 新增功能`、`### 体验改进`、`### 问题修复`、`### 升级注意事项` 和 `### 安全修复`；不要保留空分类。
- git-cliff 默认排除纯 CI、测试、文档和重构。破坏性变更会保留；其他有用户影响的提交可在正文添加 `Release-Note:` 提醒整理者纳入。
- 兼容性、数据迁移和安全影响应明确说明。非标准提交保留为“待分类”，需要人工判断。
- 整理完成后删除 `<!-- release-review-required -->`，再同步并校验。

```bash
pnpm changelog
pnpm release:check
```

版本 Markdown 是唯一说明来源。`pnpm changelog` 仅更新当前版本在 `CHANGELOG.md` 中的段落，保留历史人工编辑；GitHub Release 和更新清单读取同一份说明。空内容、占位文字、未删除的审核标记、不同步的 changelog 都会阻止发布。

`release:check` 同时检查准备时的提交到当前 HEAD、暂存区和工作区的变化，以及未跟踪文件。四处版本文件仅允许修改根应用的版本字段；依赖、脚本、Tauri 配置和锁文件的其他变化都需要重新审核。待编辑的当前版本说明、元数据和 changelog 可以保持未提交状态。

不要在准备说明后夹带新的功能提交。若代码或 Latest 基线变化，应重新核对完整范围，并更新说明及元数据中的 `baseTag`、`baseSha`、`headSha`；不得仅删除校验绕过错误。可以使用以下只读命令重新查看候选内容：

```bash
pnpm exec git-cliff --offline --ignore-tags '.*' --strip all BASE_SHA..HEAD
```

历史版本保留原有 changelog；新流程从下一次准备版本开始使用独立说明文件，不重写已公开的版本。

## 提交和发布

审核变更后，创建英文 Conventional Commit 版本提交，再创建与四处版本完全一致的 annotated tag。仅推送本次发布 tag，避免 `--follow-tags` 顺带推送其他本地标签。遵循仓库的提交工具规范。

CI 发布顺序：

1. 校验版本、已审核说明、基线和 tag SHA；拒绝重建已公开版本。
2. 对固定 SHA 运行前端测试和构建，将 dist 保存为本次运行的 artifact。
3. 并行运行 macOS ARM64、Windows x64 打包与 Quality Gate（双平台 Rust 测试、Clippy、格式检查及 SSH/SFTP E2E）。打包和 Rust 检查共用本次已通过测试的前端 dist，避免重复前端测试和构建；所有产物来自同一 SHA。打包和全部检查均成功后才能发布。
4. 在共享发布锁内检查双平台资产完整性，用配置中的更新公钥执行真实 minisign 签名验证，生成 `SHA256SUMS`。
5. 上传到 GitHub 草稿，重新下载并校验每个资产的 SHA-256。
6. 公开版本但暂不切换 Latest；验证公开更新清单和下载地址后，才将稳定版设为 Latest。预发布始终不设为 Latest。

正式发布不接受临时覆盖说明参数。要调整说明，应在发布前修改版本 Markdown。

main 和 PR 的独立 Quality Gate 仍执行原有前端及双平台检查。发布流程仅复用同一次运行内的前端产物，不跨提交或跨运行复用检查结果。并行打包可缩短等待时间，但后端检查失败时已经执行的打包会消耗额外 runner 时间，产物不会公开。

## 失败和恢复

- 公开之前失败：修复环境问题后可以重跑同一 tag。只清理和重新上传对应草稿的附件。
- 需要修改代码：创建新版本与新 tag，不移动已有 tag。下次说明仍从实际 Latest 计算，自动覆盖失败版本的变更范围。
- 已公开后失败：禁止重新构建覆盖附件。Latest 尚未切换时，稳定用户仍使用上一版。维护者检查已公开的原始附件和签名、确认公开下载恢复后，可在 GitHub 将该版本设为 Latest；如果产物有缺陷，发布更高版本修复。
- 不通过覆盖旧包或自动降级恢复。涉及本地数据兼容性的回退必须单独评估。

可以在 GitHub 仓库设置中启用 immutable releases，进一步锁定公开资产；此设置不由准备脚本修改。

## 验证与范围

```bash
pnpm exec vitest run scripts/__tests__/release-pipeline.test.mjs scripts/__tests__/release-review-regressions.test.mjs scripts/__tests__/build-updater-json.test.mjs scripts/__tests__/ai-runtime-gates.test.mjs
actionlint
# 需要 minisign；macOS 可使用 brew install minisign
node --test scripts/release-signatures.integration.mjs
```

签名测试会临时生成真实密钥，对实际文件签名，并检查文件篡改和错误公钥能够被拒绝，不使用替代签名。

当前仍使用 macOS ad-hoc 签名，尚未配置 Apple Developer ID、公证或 Windows 发布者证书。更新包签名验证不能替代操作系统代码签名。正式证书接入、安装后启动和跨版本升级的实际验收仍需在对应平台完成。预发布供测试者手动安装，客户端目前只有稳定更新入口。
