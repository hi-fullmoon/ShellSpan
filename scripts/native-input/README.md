# 原生输入构建与验收

从仓库根目录运行 `node scripts/native-input/verify.mjs --help` 查看入口。每次选择一个验收范围，按对应说明准备真实采集、隔离夹具和平台环境。

## 通用验证

| 范围 | 命令 | 覆盖 |
| --- | --- | --- |
| GNU 原型（P0） | `node scripts/native-input/verify.mjs prototype --upstream` | 固定 Bash 版本、原生 PTY、浏览器回放，可加 `--ssh` |
| 终端显示（P0） | `node scripts/native-input/verify.mjs display` | 正式安装的 xterm、复制、控制帧边界、重排和提交，可指定已有采集 |
| NIP 协议（P1） | `node scripts/native-input/verify.mjs protocol` | 固定 Bash 5.3 生产者、Rust runtime、真实控制帧、浏览器绑定，可用 `--schema-only` 核验已有采集 |
| 应用集成（P2） | `node scripts/native-input/verify.mjs integration` | 生产资源、App、隔离 SSH、Linux 几何、终端生命周期，可用 `--components-only` 限定组件检查 |

协议与应用集成共用 Rust runtime 和前端回归清单。原型和正式显示验证沿用各自的采集与摘要规则。详细前置条件见 [GNU 原型与显示](prototype/README.md)和 [NIP 协议](protocol/README.md)。

## 平台验收

- macOS arm64 的固定 Zsh/ZLE 资源由 `bash scripts/native-input/acceptance/build-macos-editor.sh` 构建，桌面验收使用 `acceptance/` 下的 macOS 和 ZLE 场景。
- Linux Bash 的资源入口是 `python3 -B scripts/native-input/integration/build.py`。aarch64 Zsh 资源入口是 `sh scripts/native-input/acceptance/linux-build.sh`。SSH 及不同 glibc 版本按 [Linux SSH 验收](../../docs/design/agent-terminal-input-linux-x86_64-ssh.md)执行。
- Windows x64 的资源入口是 `node scripts/native-input/acceptance/build-windows.mjs`，打包和启动场景见 [统一验收标准](../../docs/design/agent-terminal-input-acceptance-checklist.md)。
- `node scripts/native-input/integration/matrix.mjs --list-cases` 列出 Bash 场景。`node scripts/native-input/acceptance/ssh-recovery.mjs --list-cases` 列出双 Shell SSH 恢复场景。 [SSH 恢复前置条件](../../docs/design/agent-terminal-input-zle-ssh-recovery.md)

`pnpm native:prepare` 准备打包资源。`node scripts/native-input/export-fixture.mjs --help` 查看如何从已采集的 PTY 和视口报告导出回归样本。`node scripts/native-input/freeze.mjs integration` 或 `node scripts/native-input/freeze.mjs acceptance` 冻结当前源码并按验收范围记录环境或归档摘要。测试产物按 `prototype/`、`protocol/`、`integration/` 和 `acceptance/` 写入 `artifacts/tests/native-input/`。发布构建按同样的用途写入 `src-tauri/target/native-input/`，打包资源位于其中的 `generated/`。冻结验收须使用与当前源码匹配的清单。

旧工作区可在原生资源构建退出后运行 `node scripts/native-input/migrate-build-layout.mjs` 迁移本机缓存。命令保留已有文件和 x86_64 隔离缓存，遇到同名目标目录会停止。
迁移后首次打包需完整重建原生资源。本机打包前，若需要在 Linux SSH 连接上使用可视命令，请先在 Docker 可用的环境中运行 `pnpm native:prepare --with-ssh --require-ssh`，再运行 `pnpm tauri:build`。普通资源准备会跳过缺失的 Linux 资源，生成的应用仍可手动操作 SSH 终端。`--no-build` 只适用于已经在当前源码上重新生成的资源。

Bash 资源的源码摘要和随包重建源码共用 [`integration/bash-build-inputs.json`](integration/bash-build-inputs.json)。新增构建输入时在这份清单登记对应文件。
