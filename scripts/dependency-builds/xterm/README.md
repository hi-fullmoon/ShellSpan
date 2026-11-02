# xterm 6.0.0 maintained dependency patch

用户于 2026-10-31 明确授权正式采纳通用光标重排、软换行复制修复及同流显示切换。复制规则修复全局生效，包括默认配置的历史输出；它不是仅限 Agent 的行为。

`pnpm-workspace.yaml` 注册精确 `@xterm/xterm@6.0.0`，生成补丁为 `patches/@xterm__xterm@6.0.0.patch`。补丁包含 3 个原始 TypeScript 文件和官方构建的 UMD/ESM JS、对应 source map。package.json 和公共 typings 不变，NPM 包的 MIT LICENSE 保留。较大的生成 diff 不应手工维护，维护输入是两个小型源补丁与本目录构建配置。

## 来源与构建

`build.json` 固定 NPM 包所记录的 Git commit `f447274f430fd22513f6adbf9862d19524471c04`、官方 GitHub archive SHA-256、上游 package-lock 摘要、两个已审阅源补丁摘要。源补丁仍位于 `scripts/native-input-p0/`，与已通过可行性验证的实现逐字节相同。

官方源码按其 TypeScript project build、webpack.config.js 和 bin/esbuild.mjs 构建，没有自定义 JS 字符串替换。构建根位于系统临时目录，避免父项目的 xterm typings 污染上游 TypeScript。Node 为项目要求的 24，TypeScript 5.5.3、webpack 5.94.0、esbuild 0.25.2 来自固定上游锁。构建不运行上游 Mock 单测，也不把编译测试源码计为功能验收。

上游 lock 缺少 esbuild 的可选平台包记录，npm 11 拒绝该锁。这里使用独立、完整性锁定的 npm 10.9.2 安装原始上游锁，跳过与浏览器包无关的 native postinstall。esbuild 使用本目录 pnpm-lock 中固定的官方平台二进制，通过受支持的 `ESBUILD_BINARY_PATH` 传给官方构建脚本；同时比对上游 JS bridge 与固定 esbuild 包一致。没有手工补写上游 lock integrity 或伪造平台包来源。此工具锁不改变产品依赖。

```bash
# 重新独立获取/构建，逐文件核对正式安装包；不会写生产源码或登记新补丁
pnpm check:xterm:rebuild

# 审阅源补丁后重新构建，并通过官方 pnpm patch / patch-commit 登记
node scripts/rebuild-xterm-patch.mjs --record
pnpm install --frozen-lockfile
```

`--record` 只把源文件及工具生成的运行产物复制到 pnpm 的 edit directory，再由 pnpm 生成和安装补丁；不手工修改 node_modules 或产品 dist。`artifacts.json` 由真实构建生成，保存 7 个文件的 SHA-256、工具锁和平台二进制摘要。每次构建另在忽略目录写完整输入、命令退出码及日志；独立干净构建已与正式安装包逐字节一致。

## 正式包与显示模块验收

```bash
# 无需旧机器捕获目录，使用仓库真实 PTY 冻结显示片段
pnpm test:terminal-native-display

# macOS arm64：构建固定 GNU Bash 5.3 / Readline 8.3.6、重新采集并验证
pnpm test:terminal-native-input:p0:formal

# 只采集/验证相关复制，或只验证同流模式
pnpm test:terminal-native-input:p0:copy
pnpm test:terminal-native-input:p0:inband
```

完整入口缺少输入时生成真实 capture，不 skip；也支持显式 `--captures`（ownership）、`--copy-captures`、`--compat-captures`、`--geometry-captures`、`--commit-capture` 回放。它通过 `pnpm patch --ignore-existing` 提取原包生成对照；候选始终直接加载正式 node_modules 运行包，不再次套实验补丁。结果记录正式 pnpm patch hash、实际 JS/source 摘要及所有 capture 路径。没有硬编码旧时间戳作为必需输入。

控制器的就近 fixture 是从真实 PTY 逐字节截取的显示包，包含原始流 SHA、offset、长度与 module 来源，不是生命周期回执。可用新采集重新生成：

```bash
node scripts/export-native-display-fixture.mjs --captures <successful-ownership-capture>
```

`src/lib/terminal/native-input-display.ts` 只接受显式 native 模式和调用者提供的 binding；当前 legacy/raw registry 没有接入。线上标识、协商和生产恢复留给 P1/P2，见 `protocol/native-input-display.md`。P0 的协议原型键不是正式线上标识。
