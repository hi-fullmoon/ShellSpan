# Zsh 原生后台显示候选复查

开始于 2026-10-25，最终迁回与窗口验收完成于 2026-10-26（上海）。基础 HEAD `88eecce58a3024e92aa1db67677888c26e912cdf`。13 份修复文件及后续 5 文件双显增量均已由协调会话通过文件补丁迁回主检出，并逐项校验冻结摘要；未暂存、提交、推送或发布。

结论：**本轮 Zsh 修复的原生门禁、独立复核与主窗口模型演示均已通过**。首个后台源码及无后台普通多行前台源码均只显示一次，BG4/BG7 与着色仍通过。已有其他受控作业时仍有必要的原生重绘范围，不能宣称所有场景的源码片段都只出现一次；不宣布整个跨平台矩阵完成。

## 协调独审与主窗口验收

协调会话独立运行执行状态测试：21 passed / 2.70s；真实 32 列 Zsh 回归：1 passed / 45.76s。其独立原始流和最终单元格 `/tmp/shellspan-root-review-native-display.raw.bin`、`.cells.txt` 中，12 条唯一编号后台输出各出现一次，且均没有 `__shellspan_job_validate` 或 `__shellspan_job_control`。双显增量的生产变更随后独立复核，并按 5 文件冻结摘要迁回；另外 8 份文件仍与初次冻结逐 SHA 相同。之后只有本复查文档追加交付事实，不改变已验源码或配置。

主检出通过 `pnpm tauri:dev` 重建并启动开发窗口 `.shellspan-dev-HXXBbo/ShellSpan Dev.app`，继续使用 1420 服务和用户实际 Powerlevel 配置。通过原生 UI 选择可视命令模式及 MiniMax-M3.1-Flash，实际完成两轮、共 4 次工具调用：

- 后台启动 `for n in {1..120}; do printf 'FINAL-LIVE-%s\n' "$n"; sleep 1; done`，返回 `job-07cbb435b6cf4cdcbb68230ef25b9c5b`；同句柄等待 5000ms 超时后停止，`state=exited`、`nativeActive=false`、`exitCode=143`。窗口实际显示一份启动源码、连续 `FINAL-LIVE-1` 至 `9`，保留原生作业结束通知；没有私有 trap/eval 包装或 poll/stop 命令刷屏。
- 后台作业停止后，单次前台调用执行两行 `printf`，分别输出 `FINAL-MULTILINE-A`、`FINAL-MULTILINE-B`。两行源码和各自输出在实际窗口各出现一次，退出码 0，原有语法着色保留。

首轮迁回后发现的源码双显仅是修复前窗口记录，未倒填为最终通过。最终开发窗口保留在上述结果页面；自有演示后台进程已退出，未操作其他服务器或未知进程。原生重绘、受限选项与平台边界仍按下面各节说明。

隔离 worktree 的归档工具因其仍是实施会话的主检出而拒绝操作，因此保留原样，未手工删除。必要忽略证据已经复制到主检出的 `.phase4-acceptance/source-once-20261026/`；这一清理限制不影响主检出已迁入的修复与当前运行窗口。

## 原窗口双显增量

首个后台源码与无后台多行前台均新增最终 VT 单元格次数等于 1 的断言；前台另用真实文件内容 `once` 证明只执行一次。修复前实际 P9k 用例 `/tmp/shellspan-duplicate-baseline-fixed-fixture.log` 在前台断言以 2 对 1 失败。

接收器已经原生显示 BUFFER，接受时不再无条件 `zle -I`。接收开始时只读取原生 `jobstates/jobtexts`，记录是否已有其他前缀为受控组的 running/suspended 作业；有则保留保护异步输出的接受重绘，消费后清除，并在 prompt/discard 清除。首个准备记录不算真实子作业；不依赖 broker prepared 状态，不更改用户通知、CHLD 或着色。

| 增量验证 | 结果 |
| --- | --- |
| P9k 180×30，普通源码各一次、BG4/BG7、着色 | 1 passed / 38.55s，`/tmp/shellspan-source-once-live-job-redraw-wide.log` |
| P9k 32×30，相同断言 | 1 passed / 39.69s，`/tmp/shellspan-source-once-live-job-redraw-narrow.log` |
| 全量 Rust，含真实宽/32 列与迟到回执恢复测试 | 1186 passed / 0 failed / 59 ignored，76.78s，`/tmp/shellspan-source-once-final-rust.log` |
| 格式与 include | cargo fmt --check、git diff --check、56 个 include 检查通过 |

直接删除接受前 I 的试验保留为失败 scope：普通 Zsh 32 列通过，但 P9k 宽窗口丢 BG4，见 `/tmp/shellspan-source-once-no-accept-invalidate-wide.log`。当前条件重绘保留了原长/短输入重叠，没有删掉覆盖或把失败视作 flaky。

活跃作业时的范围如实保留：当前长源码尾部和短源码可各有 2 份原生显示片段，源码仍只执行一次。无 ShellSpan 的实际 P9k 原生基线分别测试普通 Enter 和公开 `zle -I; zle accept-line` widget；默认 Enter 为源码 1 份、BG4 为 0，公开 I 重绘为源码 2 份、BG4 为 1，两者真实文件内容均为 `once`。这是公开原生重绘基线，不能表述成默认 Enter 本来就有两份源码，也没有抑制普通原生作业完成通知来减少计数。

增量证据位于本 worktree 忽略目录 `.phase4-acceptance/source-once-20261026/`，包含原生基线脚本、实际流、标准 vt100 解析与结果，以及当前流/单元格/源和冻结摘要。原主检出的 13 份初次冻结文件逐 SHA 仍匹配，以下 5 文件是本次新增差异，由协调会话负责迁回：

- `src-tauri/src/terminal_integration.rs`
- `src-tauri/src/tests/terminal_integration.rs`
- `protocol/agent/runtime/terminal-protocol-rfc.md`
- `protocol/agent/runtime/visible-terminal-unification-plan.md`
- `protocol/agent/runtime/zsh-native-job-display-review.md`

## 初次冻结的实现与证据

Zsh 显示短 `job-*` 标记与原始脚本；标记安装完成回执后返回，源码在原生异步子 Shell 顶层执行。长/多行输入及当前 PTY 有仍可能输出的受控作业时的短输入，通过限时有界接收、原生 printf 解码、一次 BUFFER 替换、完整 M 确认后原生接受；无作业的短输入保持原路径。poll/stop 使用空编辑器确认、65 字节 descriptor 和一次性 commit widget，不写入可见编辑器或历史。保留 S/E/P/Q 审计、owner/generation/integration、每次写入的冻结绑定复核、提交/取消互斥与不重放。原生 parser 独立验证原始源码与整个后台组，拒绝可以闭合外层的无效源码。前端没有过滤、补显或回放输出，没有修改全局 CHLD/jobs/echo，也没有改变着色和预测配置。

实际命令及日志：

| 验证 | 结果及范围 |
| --- | --- |
| 最终完整 Rust | **1186 passed / 0 failed / 59 ignored，76.75s**；`/tmp/shellspan-frozen-final-rust.log`。包括真实普通 Zsh 宽/32 列、Bash 3.2、独立源码解析与组逃逸拒绝、状态/作用域、取消接管与恢复回归。 |
| 真实用户 Powerlevel，180×30 | **1 passed，40.04s**；`/tmp/shellspan-frozen-final-powerlevel-wide.log`。 |
| 真实用户 Powerlevel，32×30 | **1 passed，40.17s**；`/tmp/shellspan-frozen-final-powerlevel-narrow.log`。实际源码 printf 单元格仍有原生语法着色。两轮均先核对实际 HISTFILE 的独立目录，再执行业务源；未把固定简单提示符的额外前台断言套到用户 profile。 |
| 每秒输出与长/短输入重叠 | 两轮 Powerlevel 各真实输出 12 条。BG4 同步到约 5KB 源码已到达但尚未接受期间；BG7 同步到低于 512 字节短命令的相同阶段。原始流与实际尺寸单元格均各一次且有序；实际 poll 时作业仍运行，停止/自然结束及原生通知没有私有实现。没有缩短长输入或移除重叠。 |
| Zsh M 丢失/迟到 | 最终全量包含真实 source receiver 的 M 暂存、取消、接管、旧 nonce 注入继任操作、正确 M 截止时间后迟到；均不接受源码、不解锁恢复、不重放。暂存帧来自真实 BUFFER 与 descriptor，经原私有帧解码器读取，非伪造 ACK。另一个专项轮次 `/tmp/shellspan-zsh-late-frame-ack-test.log` 为 1 passed / 10.71s。 |
| Bash 5.3 影响检查 | **1 passed，42.40s**；`/tmp/shellspan-frozen-final-bash.log`。只证明影响范围，未宣称 Bash wrapper 显示已修复。 |
| 协议/验收脚本 | **4 个文件 28 tests passed**；`/tmp/shellspan-frozen-final-script-contracts.log`。V/M 定义保持私有，非法类型/descriptor/NUL/过长/额外字段拒绝；布局入口识别新的 Zsh 固定组，Bash/Windows 前缀保持原约束。Node runner 语法检查通过。 |
| 真实布局辅助入口 | 从冻结二进制真实 S 记录提取 Zsh acceptedLine，运行 `verify-native-editor-layout.py`，32×30 原生 BUFFER 与源 SHA 同为 `3845e59ea3e5b6827dbd41d8447369c707e015c2630660b742762f24b22bf062`。仅布局、不接受或执行源，不替代生产 receiver/窗口/模型验收。来源复验 1 passed / 38.47s。 |
| 格式与冻结 | cargo fmt --check、git diff --check、56 个 include 检查通过。六份 Rust 的 before SHA 在全部最终原生轮次之后逐项 OK；之后只补齐脚本、schema 与文档，各有单独检查。 |

最终归档独立放在主检出忽略目录 `.phase4-acceptance/native-job-display-20261025/final-20261026/`，包括最终日志、两轮真实 profile 原始流/cells/后台及长短前台源、Rust 前后摘要、测试二进制摘要、13 份冻结文件摘要和 patch。早期父目录记录不与最终轮次混用。源码变更后不得复用本次通过。

## 受限支持与证据边界

`errexit`/`errreturn` 与非零原状态组合现由 native accept 在执行源码前返回 `TERMINAL_BACKGROUND_UNSUPPORTED`，不更改用户选项，不影响已有作业管理；子进程 marker 保留防御性拒绝。早期默默跳过源码的日志 `/tmp/shellspan-zsh-errexit-regression.log`、`/tmp/shellspan-zsh-errexit-regression-normal.log` 仅是修复前证据。最终全量包含正常测试 `native_zsh_errexit_rejects_nonzero_marker_status_before_source`、真实 PTY 的两种选项拒绝/选项保持/已有作业管理，以及零状态下源码内 false 的原生退出语义。此处是明确的受限支持，不是该组合完整执行语义的验收。

修复前 `/tmp/shellspan-native-display-final-gate.log` 的 1184 passed / 1 failed / 58 ignored、真实 32 列 BG4 单元格为 0 的证据保留为失败 scope，未改判 flaky。最终用完整 BUFFER 原生接收、ZLE 原生重绘修复；12 条输出、相同 BG4 重叠及额外短命令 BG7 均由最终轮次证明，不复用早期 0.1s 轮次。

独立无 ShellSpan 的原生基线位于 `.phase4-acceptance/native-job-display-20261025/native-zsh-baseline.py`。32 列、超过视口的长输入首行在纯原生 Zsh 中也不保留（`plain-long-source-analysis.json` 的 firstFinallyRetained=false），不能把它与 BG4 丢失混同。用户 Powerlevel profile 在纯原生 Zsh 中执行 `setopt errexit; false && true` 后实际 EOF（`profile-errexit-baseline.json`），对应 profile 的异常选项组合不据此伪称已支持。基线先从实际 Shell 核对独立 HISTFILE，再发送测试源；后续用户历史摘要仍 OK。

超出视口的约 5KB 输入首行按原生 ZLE 基线裁剪；最终保留全部源与重叠，核对真实 M/接受记录的整段一致性和可见源码尾部，没有补印首行制造“完整可见”。后台批准脚本及短源的实际源码文字继续断言。当前只有本机原生 PTY/VT 与真实 profile 验收；当前代码迁回、原用户桌面窗口/模型演示由协调会话继续。管理 descriptor 专项丢包/关闭重连交叉矩阵、SSH 新数据 receiver、Linux 原生和其他架构仍不外推为已验。

## 冻结文件（13 份）

- `src-tauri/src/agent_runtime/native/terminal_execute.rs`
- `src-tauri/src/agent_runtime/tests/native/terminal_execute.rs`
- `src-tauri/src/terminal_broker.rs`
- `src-tauri/src/terminal_integration.rs`
- `src-tauri/src/terminal_jobs.rs`
- `src-tauri/src/tests/terminal_integration.rs`
- `scripts/verify-ai-session-stream.mjs`
- `scripts/verify-native-editor-layout.py`
- `scripts/__tests__/terminal-protocol-contract.test.mjs`
- `protocol/agent/runtime/terminal-protocol-v1.schema.json`
- `protocol/agent/runtime/terminal-protocol-rfc.md`
- `protocol/agent/runtime/visible-terminal-unification-plan.md`
- `protocol/agent/runtime/zsh-native-job-display-review.md`

## 历史文件副作用

真实 profile 首轮测试在 configure_command 重建引导文件前添加重定向，后被覆盖，导致 `/Users/zhengbiwen/.zsh_history` 新增一条只读 HISTFILE/prompt function 探测命令。匹配本轮完整探测模式的条数为 1。没有恢复、截断、清空或删除用户历史。修正为 configure_command 后、首次可编辑 prompt 前追加私有 HISTFILE，且实际 Shell 查询核对之后才继续。修正后的前后摘要校验 `/tmp/shellspan-zsh-profile-history-retry-before.sha256` 持续为 OK；原失败前摘要 `/tmp/shellspan-zsh-profile-history-before.sha256` 保留，不把它改判为一致。

## Windows 边界

用户明确要求保持现有着色；未采用 PSReadLine 简化渲染，未关闭语法着色或预测。此次仅形成 Zsh 候选与 Bash 影响检查，没有运行 Windows 真机或更改其验收结论。Windows 仍按独立报告续验；旧冻结轮次不证明本候选，也不能用 macOS 原生 PTY 结果覆盖 Windows 显示、持续输出和模型/UI 验收。
