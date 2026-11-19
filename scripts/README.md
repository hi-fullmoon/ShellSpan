# 项目脚本

从仓库根目录运行下列命令。常用入口由 `package.json` 提供，专项验收使用文档中的直接命令。

| 目录 | 用途 | 入口 |
| --- | --- | --- |
| `checks/` | 终端边界、Rust include 格式、LLM 目录和 AI 样式检查 | `pnpm check:ci:static`、`pnpm check:ai-styles` |
| `dev/` | Tauri 开发启动和 Cargo runner | `pnpm tauri:dev` |
| `generators/` | Petdex 校验器和应用图标生成 | `node scripts/generators/generate-petdex-validators.mjs --check` |
| `verification/` | Agent、应用、SFTP 和各平台终端专项验证 | [专项验证命令](../docs/testing.md) |
| `native-input/` | 原生输入构建、冻结、样本导出和分平台验收 | [原生输入构建与验收](native-input/README.md) |
| `dependency-builds/` | 固定版本依赖的补丁、构建配置与重建入口 | [xterm](dependency-builds/xterm/README.md)、[PSReadLine](dependency-builds/psreadline/README.md)、[Bash](dependency-builds/bash-native/README.md) |
| `release/` | 版本准备、发布检查、签名和恢复 | [发布流程](../docs/releasing.md) |
| `agent-sandbox/`、`remote-sandbox/`、`remote-sudo/` | 本地沙箱预览、远端隔离和受限 sudo 的专项验证 | [沙箱验收](agent-sandbox/README.md)、[受限 sudo](../docs/remote-sudo-runner.md) |

`fixtures/` 存放专项验收引用的夹具，`perf/` 存放性能验证页面，`__tests__/` 存放脚本回归测试。仓库内的测试日志、截图和隔离源码快照写入 Git 忽略的 `artifacts/tests/`。
