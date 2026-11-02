# P3 原生输入迁移审计

更新日期：2026-11-02。最新状态：**P3代码已实施并交接，统一平台验收尚未完成**。按用户最新
顺序，P4代码可在独立会话继续；当前仅无界面编译/类型/静态检查，不启动任何实机验收。
生产未验收准入保持关闭；不授权commit、push或发布。P2限定结论与以下明确源版本证据不变。
代码状态、最新静态检查和待统一验收项见[P3代码交接](agent-terminal-input-p3-code-handoff.md)。

## 当前证据索引

此表区分既有封存限定结果与统一验收；后者尚未完成，代码实施状态不替代平台验收复选框。

| 范围 | 封存源码 / 轮次 | 已确认结果与限制 |
| --- | --- | --- |
| Mac 当前 API 正常模型链 | `29c6ca1a` / `0f41d912` | 正式 Core `cc7f4263` / xterm `48f368b5`，7 calls / 7 results、17/17 leases release、审批、完整源/早期输出、父 scope/history/停止/exit7 通过；旧 `7ad59548/f17a0777` 仍为其自身限定证据 |
| Mac 当前 API 启动与窗口 | `29c6ca1a` / `00a03950` | 实际 registry/Broker localPty/native-inline、Unicode11/owned reflow、nativeJobControl 与 user lease 就绪；CUA 首次采样直接可见彩色提示符，无点击/Raise/命令，不是 frame0 或持续无闪烁证明 |
| Mac 输入后输出背压 | `cd0b11dd` / `d387c962` | 完整输入/持久意图/Started 先到，实际暂停 PTY、私有结束先到仍不提前完成，恢复后完成 |
| Mac 争用/重试/接管/关闭 | `2e1c3a57` / `97ee9104` | 真实 5 操作、10 call/result、原生 CUA 窗口与签名镜像退出检查 |
| Mac 可见前缀取消 | `60d3ed04` / `9bef7ea7` | 部分输入实际可见、真实清理、未提交无副作用、普通用户恢复 |
| Mac 交互/TUI/凭据拒绝 | `60d3ed04` / `4c6da09c` | 实际交互及凭据提示拒绝；相关原生字节和结果保留 |
| SQLite 并发持久化 | Windows `7d89f8f9` 及 Mac 独立探针 | 修复前 Windows 49 失败/18 未结原件保留；修复后各 800 次、0 失败/0 未结；不是模型应用复验 |
| scratch 并发重开 | `scratch-reopen-baseline.log` / `scratch-reopen-after.log` | 真实 persist/reopen 修复前 206/500 所有权错误；独立私有 pending 目录原子发布后 8 测试通过/1 受控 SSH 显式忽略，含并发与 symlink 拒绝；新源 Mac/SSH App 通过，Windows 尚未复验；原 16,000 次探针未覆盖重开枚举 |
| Mac 当前 API 背压旧轮次 | `29c6ca1a` / `ba26c7a7` | 整轮 FAIL：4 calls/results/executions 后草稿焦点变为 BODY；清理另报 scratch 所有权错误。保留两项独立诊断，后续新源通过分列，不把旧 FAIL 回填为通过 |
| Mac scratch 修复后背压 | `b13af012` / `bfb51cea` | 新独立场景退出 0；实际 FULL/持久意图/Started 后暂停输出，私有结束先到仍扣留工具结果，250ms/2702 字节后恢复；7 calls/results、17/17 leases，焦点本轮通过，不据此解释旧 FAIL 原因 |
| Mac 当前 API 取消/交互/争用 | `b13af012` / `b5de27d5`、`3f3faff8`、`d4e42350` | 三个完整入口退出 0；可见未确认前缀取消、0 持久意图、用户恢复；REPL/TUI/fresh-task 凭据拒绝 8 calls/results；争用重试/接管/关闭 5 操作、5 calls/5 results |
| Mac 当前 API 原生边界 | `b13af012` / `scoped-runs` | namespace guards 11、EOF 14、实际 Broker/DTO 绑定 1、manifest 路径 1、普通默认关闭准入 1，均为实际入口退出 0 |
| Mac EOF/接受缝隙/显示退出 | `146311d7`、`93bf450c` | 十场真实组件；实际接受→父解析器前 EOF；40 次浏览器销毁前恢复，均有明确版本边界 |
| Linux 生产 SSH/EOF | `2e600c35` / `e5312889` | 八操作及未提交前缀 EOF，真实 143/ESRCH、用户 PTY 恢复、凭据删除；不覆盖后续名称冲突检查变化 |
| Linux 当前 ZLE 原生 App | `b13af012` / `e8f484a2` | 实际 sshPty/native-inline、正式 Core `c9e451bd` 与 xterm `48f368b5`，真实 MiniMax 七工具、17/17 leases、审批/停止/exit7、完整源/早期输出通过；正常 API 删除临时凭据并核验不存在、锁号停容器 |
| ZLE 原生 append API 与完整输入 | `7ec4c0a7` / 两项明确 test-only 修订 | 新 API 双目标标准构建；视口依赖修复后 Mac 16 场、Linux SSH 8 场及 775 个历史渲染帧通过；仅 Chromium DOM、组件与浏览器观察，不能替代 App 全矩阵 |
| App/Broker 提交后不明与恢复 | `15a3a03c` / `98bae311` | 完整真实模型入口退出 0；迟到 Started 保持 Uncertain、禁写、单次执行与显式恢复通过，CUA 有界窗口确认；不覆盖初始未聚焦绘制或无闪烁 |
| GNU 原生显示 ABI | [独立审计](agent-terminal-input-gnu-display-abi-audit.md) | Root 独立固定源码的三版本 Mac 标准构建与真实 NIP/显示通过，Linux/SSH/App 状态以该报告为准；旧 owner GNU 资源不能用于新包 |
| Windows 真实模型链 | `25d4de78` / `c81936a3` | 两种启动/job 能力已到，模型应用仍因 journal/scratch 失败；临时凭据清理已核实，待连接恢复复验 |

## 当前实现

- 目标编辑器状态与 FFI：`src-tauri/native-input-editors/`。ZLE 公开 widget/builtin 与
  PSReadLine 公开 API 持有真实缓冲、游标、提交和清理观察；前端不保存原生编辑器副本。
- 本地/SSH/Windows 加载器：`terminal_command/local.rs`、`remote.rs`、`windows.rs`。
  固定源摘要与实际 Shell、编辑器、模块、relay 摘要共同建立 VerifiedNativeProfile。
- NIP/1、Broker 和现有提交账本继续负责完整身份、不可变计划、完整证明、FULL 意图事务、
  最终准入和单次交接；`terminal-submissions` 及旧目录迁移拒绝规则不变。
- Zsh 前台源码交回父解析器；PowerShell 根据真实 AST 固定 host 行并交回 ConsoleHost。
  既有作业 helper、状态复制与 Windows Job Object 路径继续使用。

## 已观察证据

| 环境及范围 | 明确源码/证据 | 当前结论 |
| --- | --- | --- |
| macOS arm64，系统 `/bin/zsh` 5.9，真实生产启动及私有传输 | `.native-input-p3/acceptance-source/9f5202e8-9bb6-41cf-b698-24516b9d71b1/ShellSpan/.native-input-p3/production-zle-signal-fix.log` | 1 个真实测试通过，0 ignored；限定启动/父解析器/既有后台控制 |
| 同环境，9 个操作、独立父作用域读取、持续后台输出、长 Unicode 输入、100/32/180/40 列变更和执行中 Ctrl+C | `acceptance-source/bf5ff6a8-db4e-4400-9c28-c9e9d90a4264/ShellSpan/.native-input-p3/production-zle-signal-diagnostic-fixed.log` 及 `production-zle/f2235966-9784-4761-b76b-d3c55021fbdd/` | 单轮通过；交接中断间隙仍需独立、稳定回归，不能把这一轮外推为全部取消验收 |
| 普通用户前台中断，原 Zsh 与启用 provider 的实际对照 | `.native-input-p3/signals/5d7f66b4-a32d-4f9f-8cce-bff746dd8a6e/` | 两个实际 PTY 均返回编辑器并接受下一条用户命令；不是 Broker/GUI 验收 |
| Linux aarch64 / glibc 2.36，实际 `/bin/zsh` 5.9，SFTP + relay + 用户 SSH PTY | `acceptance-source/f782ce6c-156a-4cf6-b59d-aff406289fff/ShellSpan/.native-input-p3/ssh-fixture/production-test.log`、`fixture.json`、`run-result.json` | 1 个生产传输测试、6 个操作通过，0 ignored；凭据经系统钥匙串/内存管道使用并删除 |
| Windows PowerShell 5.1.26100.9711 / PSReadLine 2.4.5，真实 ConPTY | Windows 完整源副本 `D:/Developer/ShellSpan-native-input-p3-app-f604fa33-01dc-4354-bc83-556c322ce99d/.native-input-p3/conpty-latest-51-absolute/` | 6 次真实提交；正文前输出、独立父作用域、退出 7 后状态/错误集合保留通过；仅组件层 |
| PowerShell 7.6.9 / PSReadLine 2.4.5，真实 ConPTY | 同一完整源副本的 `conpty-latest-7-absolute/` | 独立 6 次真实提交通过；不能覆盖 5.1 或桌面/Broker/模型验收 |

Linux 该轮产物：模块 SHA-256 `3b7f0409a7b49f72ef3692e69a8ba18ef5099c8597d1abe4618814827b2fb7cf`，
relay `d05c9e24a61ba132721354816f1da71c183fde40f39e5ebc88ce6a694bbb2953`，
绑定 Shell `1ebc9b7012541bdc45fe8cbb9f752c0dc49aeb47dea0fd76d755639e7554e6d3`。
这些摘要证明该轮实际制品，不能替代其他源码版本的重新构建和验证。

## 完整性与桌面状态

后续信号修正：前台实际诊断程序发现旧线程时钟方案可将 SIGINT/SIGHUP 的屏蔽状态带入
外部进程；`ps` 的进程级字段不足以发现此问题。现改为 ZLE 线程内的公开 zselect 有界等待，
不全局解屏蔽信号。源码副本 `1e1d77f9-d1d9-45eb-9448-432e0446b9d2` 的
`geometry-capture/b8e5a78f-209a-42ec-9ed5-68020fa19cdf/result.json` 记录四种初始列宽的
执行中中断和一轮提交交接中断全部通过，共45个操作；实际程序的 SIGINT/SIGHUP 均未屏蔽。
每轮还确认真实后台143结束及进程组不存在。该组件结果仍不覆盖实际 App 的取消/接管路径。

源码复制/搜索仍为 FAIL。`source-copy-comparison/54ae3c06-3db3-432a-838e-b3e5075d80be`、
`04d5973e-6181-48ae-acb5-085fca540559`、`1b9eaf9b-6bc3-435b-b762-71ba0760417e` 和
`c7bf2610-5f1b-4363-9770-2ab9935b45c9` 保留真实普通ZLE与native对照：实际原生缓冲摘要
均与完整源码相同，但PTY中出现字面`<200d>`，完整原文copy/search不成立。隔离私有HOME中
分别试验PRINT_EIGHT_BIT及COMBINING_CHARS均未达到完整要求；未修改用户配置或放宽断言。
独立 SDK 调用报告 ZWJ 宽0；后续 `root-system-zsh-width/4b28f6d1-4e62-4f43-bfc5-6deb8a9384d3`
实际 dlsym/dladdr 确认绑定 `/bin/zsh` 主程序自身导出 u9_wcwidth，ZWJ=-1，同进程 libc
wcwidth=0。系统 ZLE 的字面 `<200d>` 与该差异一致。原始普通基线失败仍保留，不能据此
豁免 native 完整原文要求，也不能把业务映射放进 xterm。

每个正式应用轮次使用完整的 tracked/untracked 文件双向映射、复制的只读 Git index、
独立静态资源、单次 token 页面及禁止 watch/HMR 的入口。新增、缺失、修改文件和 index
篡改的独立检查已执行；不排除并行 SFTP 文件来制造一致性。源码副本不注册 worktree、
不创建 refs/commit/branch。跨平台归档关闭 AppleDouble 生成，早期包含额外文件的导入
保持失败。Windows 应用入口新增真实 PE 进程、父进程、路径、SHA 和 Authenticode 状态
记录及退出后源码/资源/PE 复核；这些入口实现本身尚不能代表桌面用例已通过。

用户再次回复 Mac「已解锁」后，CUA 已实际成功读取并检查本任务精确路径下的自有窗口。
用户另行允许重启 Docker Desktop；常规停止超时后使用 Docker 官方 CLI force-stop/start
恢复，实际本地 desktop-linux 服务版本为 29.8.0。新 Linux fixture 已真实重建和运行，
旧轮次未被当作当前版本通过。
用户也授权仅对已核验、微软签名有效的同一 PSReadLine 2.4.5 模块作一次性 R 确认，未授权
Always、信任库或执行策略修改。用户另行明确授权了本任务临时复制并清理 Mac MiniMax 凭据，
这项授权及实际结果见下文；未修改全局默认线路。

Mac 源副本 `fb8c0b7f-66c2-4c60-91e5-2c0a0767300f` / App 轮次
`a81df069-7fb8-4b16-b60d-7e54206cfc48`：初始化完整源码、静态资源及签名镜像退出校验通过。
实际 MiniMax-M3.1-Flash 发出 1call/1result，脚本被 Unsupported/pre-lease/notStarted 门禁拒绝，
lease 仍属用户；该轮没有 InputConfirmed、完整命令输入证明或持久提交意图证据。

随后源副本 `45a9964e-a1f3-49f0-bc2e-2b8dd40539bf` / App 轮次
`b2ecc266-6b8d-4fb7-9ea1-59f79eae172a` 保持 FAIL：冻结时复制了尚未重建的 ZLE catalogue，
其 zle.zsh 摘要与副本源码不一致；实际 raw/unavailable/nativeProfileMismatch，0call/0result。
这是制品门禁正确拒绝，不能解释为新协商逻辑失败。旧副本及资源未覆盖。现在封存前逐项
校验选定目标的 catalogue 源文件/制品，记录其他目标陈旧状态，并将 P3 运行期全部原生资源
摘要加入冻结校验。当时启动 options/ready 协商等待新 App 复验；后续 `7ad59548` /
`f17a0777` 已完成该限定版本的真实正常七调用。可选 jobs 与输入私有通道已分开，不强开
monitor 或 jobs；随后新增 EOF 等改动的最终同版本 App 矩阵仍未完成。

Windows 初始副本 `aba582e7-d273-46d0-82f2-5840b462366e` 的缓存路径失败及其后各失败轮次
保留。新副本经过真实 Windows 编译生成 schema 后，完整封存为独立源版本，不排除该文件。
实际 Session1/Default、源码/静态资源/PE through-exit 校验已在后续轮次通过；这些不是命令
完整输入证明。标准本地路径与 verbatim 路径只读对照显示同一文件摘要、无 Zone.Identifier，
前者 MyComputer、后者 NoZone；P3 加载器复用既有路径转换，未改变签名、ACL、策略或信任。

`faf8303c-9741-4c6e-a81e-486ccf2598e6` / PS7 App 轮次
`e8198f77-813f-4adf-93ff-3635aa23f1a8` 实际 Broker 为 native-inline/ready，报告
PowerShell7 7.6.9、PSReadLine2.4.5、对应 capture1 verifiedProfileId、promptReady=true；
随后在模型鉴权前 MISSING_CREDENTIAL，0call/0result，不能覆盖提交/后台/完整桌面验收。
同副本 PS5.1 轮次 `7ef69127-44fe-4f3b-8d3b-f7519c35fdb3` 没有发布者提示，但实际找不到
PSConsoleHostReadLine，拒绝为 CUSTOM_HOST_UNSUPPORTED；其精确启动/导入环境仍在核对。
当前调用方入口捕获、独立可见入口保护及官方函数 AST 比对改动尚待新制品与真实回归，旧 PS7
ready 不能覆盖这些新 provider 源码。相关失败轮次的原用户数据/选定历史审计保持通过。

根会话隔离 Unicode11 对照 `root-reflow-diagnostic/d78cbab1-f7e7-4a7d-98fe-f95faf942208`：
同一真实 ordinary upstream5.9/private-COMBINING_CHARS 输入流，官方 addon 0.9.0 明确激活
activeVersion=11 后公共字符宽度恢复为2格、Unicode片段保留；额外硬 LF 仍使完整原文
copy/search FAIL。仅固定 raw 的离线诊断，nativeAcceptance=false，不覆盖实时 native/inband、
动态缩放、绑定 Apple Zsh 的 `<200d>` 或任何正式 provider 授权。

旧组件目录、失败轮次、原始 PTY 字节、私有控制记录及各轮 manifest 保留。Windows
`f604.../src-tauri/target` 为本任务早期编译缓存，磁盘耗尽后在确认无运行镜像后清理；
源归档、日志、完整映射和 `native-input-editors/target` 中测试过的组件镜像保留。

## 尚未完成的退出条件

- Mac 实际原生窗口、完整模型调用链、xterm 显示/选择/复制/搜索、Focus、宽窄及动态软换行。
- Windows 5.1/7 各自的实际应用、模型、Broker/FULL 意图、桌面窗口和完整后台任务停止/子孙清理。
- 提交交接期间与执行期间取消分别形成稳定真实回归；保留已观察到的交接中断超时，验证无重放、
  未知结果门禁、用户安全接管和无遗留进程。
- ZLE/PSReadLine 的用户草稿、TUI/REPL、凭据门禁、语法失败无前缀副作用、重复/迟到/错误帧、
  EOF/重连及冷启动围栏的完整实际路径验证。
- 最终源版本的资源/源码重建、兼容回归、格式及适当构建检查；当前组件通过不能替代最终版本结果。

P3 计划复选框保持未勾选。P4 删除旧实现与发布门禁均不在当前完成状态中。

## 已授权的 Windows 临时模型凭据准备

状态：用户已明确回复“允许本任务临时复制并清理”。真实轮次
`101befab-e435-4332-a366-7d3cd9536f46` 已完成正常读取、有界加密传输、正常保存/回读、
删除及正常读取缺失验证。临时引用为 `llm-94b4918b-b73b-4db5-83a6-b9268fe69893`；
OS 删除记录为 presentBefore=true/presentAfter=false，另一个真实应用通过
`ai_get_route_api_key` 返回 `MISSING_CREDENTIAL`。原用户数据及两种原历史文件未改变。
这些结果只证明该正常轮次，不外推中断、崩溃或并行配置变化恢复已通过。
两机当前 MiniMax 路线均为 `https://api.minimaxi.com` / `chat-completions` / `minimax`。
Mac 当前实际模型为 MiniMax-M3.1-Flash，Windows 当前路线为 MiniMax-M3；不修改任一全局默认。

1. 获得针对「Mac 当前保存的 MiniMax 凭据 → 受控 Windows 当前用户的本任务临时系统凭据」
   的明确授权后，再通过现有 `ai_get_route_api_key` 读取这一条真实路线；不导出整个钥匙串。
2. 使用既有已认证、固定 host-key alias 的 SSH，通过有界标准输入及私有进程内存传输，
   不把 key 放入命令参数、环境变量、文件、快照、日志或模型消息。
3. Windows 仅在独占测试数据目录中，通过正常 `ai_save_routes` 凭据路径创建新 `llm-UUID`
   引用，交由正常 OS Credential Manager 后端存储；不替换原 Windows 引用，不改用户全局
   路线、默认模型、原凭据或权限。原有宿主、适配器和模型绑定在实际请求前重新核对。
4. 正常请求仍走实际 LLM runtime/provider/审批路径；不使用假模型、认证代理或特殊工具路由。
5. 将新引用、独占数据目录、路线修订和 runId 记入不含密钥的所有权清单。成功或失败后删除
   仅本任务新建的 OS 项，并通过正常凭据读取接口确认 MISSING_CREDENTIAL。Windows store
   1.1.0 的实际目标名为 `{reference}.com.shellspan.dev.ai-provider`，Enterprise 持久性由该
   成熟后端确定；清理只操作所有权清单中的新引用。若进程崩溃，从独占 DB 的正常路线记录
   和真实 pendingCredential journal 恢复清单，不制造恢复记录或触碰其他条目。

授权仅适用于本任务临时引用，完成后必须清理并核对正常读取接口的缺失结果。

## 最近的真实模型轮次与精确限制

- Mac `2e1c3a57-5795-4a5f-9c01-d5a20c2e45a2` / 解锁后轮次
  `97ee9104-f47c-45d5-b5ba-fed1c3db919e`：争用、拒绝提交保留草稿、手动重试、运行中
  确认接管、关闭和持久对话状态复核通过。实际链路为 5 operations、10 条 call/result
  与 15 条持久 call/execution/result，三个计数口径分别保留。两个签名镜像退出校验通过。
  CUA 精确绑定当时存活的 PID 39685 / `.shellspan-dev-dzg1Sl`，实际截图可见彩色 Zsh
  提示符、真实命令与对应输出；观察记录写入该轮 `native-cua-observation.json`，截图保留
  于会话工具结果。原锁屏超时 `b0b66b3c` 仍 FAIL，不覆盖复杂 Unicode 和动态几何。
- Mac 后置背压源副本 `cd0b11dd-1f37-42fa-a882-da85741178c2` / 轮次
  `d387c962-b208-4aad-9e42-d7e85d3fc73a`：7 次真实调用通过，8 条实际提交账本均 settled。
  Started/running、完整输入确认和持久意图均真实先于暂停 PTY 的 ACK；随后仅释放预先
  冻结并批准的程序门文件。私有 Settled 先到，250ms 内结果数仍为 0、输出长度保持 2411，
  恢复 PTY 后完成原捕获边界及全部调用。两个签名镜像退出校验通过。原 `20c7d896` 的
  输入前暂停/不明草稿/query-only 失败证据未被覆盖或重放；该负例恢复仍待完成。
- Mac 源副本 `7ad59548-e90d-42d1-8fb3-e5ab9e24244f`，应用轮次
  `f17a0777-1f19-4f05-9c03-d4767606864e`：常规 7 次模型工具调用通过，三次等待均 running，
  终止 exited/143，最后 exit 7；16 次实际管理/执行租约全部释放，隔离 SQLite 的 16 条
  submissions 记录均 settled。真实普通 Zsh 基线逐字节比较通过。完整源码、静态资源、
  本机 Mac 原生资源、签名镜像到真实进程退出的校验通过。这不证明复杂 Unicode、动态软换行、
  独立背压故障、EOF/接管恢复或人工原生窗口检查通过；P3 总体保持未完成。
- Mac 源副本 `7b2dd8ec-b8dc-4c3b-9b63-925b7adba792`，应用轮次
  `dacefc28-7cac-4389-b39c-3994c8eaa789`：7 次真实调用和结果完成，三次等待保持 running，
  终止得到 exited/143，最后一条命令 exit 7。真实观察包含完整输入确认与持久提交意图。
  整轮 FAIL：此前沿用 Bash 的严格零字节断言。普通 `/bin/zsh` 在相同 170×40 PTY 上
  实际执行同一 `(exit 7)`，其 preexec/precmd 捕获区间与该结果的 194 字节逐字节相等，
  SHA-256 为 `1915224799f57097677b56d3ecbf17ebd08c147e09d54d8f3b5a70eb84e8c22d`。
  Zsh 5.9 `Src/utils.c` 在 precmd 前输出 PROMPT_SP 维护字节；既有 Zsh 捕获同样在 precmd
  结束。新断言保持原始捕获字节，逐字节比较同尺寸普通 Zsh 的真实独立捕获，不做 trim、
  控制字符剥离或 source/plan 投影。后续 `f17a0777` 已完成这项完整应用复验。
- Windows 源副本 `ab452e5c-3c86-4bd4-87e7-40612d205a32`，上述凭据轮次的 PS7：
  7 次真实工具、14 次租约释放和原生停止/exit 7 验证走到最后，整轮仍 FAIL，最终截图
  定位未在 P3 分支赋值。已改为从实际公共 cell 查找源首行，尚待新轮次复验。
- 同一 Windows 轮次的 PS5.1：真实 PTY 停在已核验微软模块的首次发布者确认，0 次模型
  调用。新启动检查放在凭据准备前；若出现同一文件的提示，仅在当前文件哈希和微软签名
  重新验证后按已授权的 R 处理，不选择 A，不改策略或信任库。尚待新轮次验证。
- 无密钥 Windows 取消验证 `357a069e-6e7f-402f-8245-ff6d88ccaa72` 尚未到接收端，
  先因 Windows 复用 runner PID 导致初始化/启动检查点同名而正确 FAIL；0 模型、未读取
  或传递任何密钥。原用户数据未改、所有实际旧 CLI/镜像退出已核实；这不计取消故障通过。
  P3 检查点/镜像记录已加入独立 UUID，保留旧证据不覆盖，读取器兼容旧文件名；待复验。
- 新文件名的 Windows `e69be33b-b760-4f77-8690-9e06937cecfc`：PS7 实际无模型启动已
  ready 并通过镜像退出校验；PS5.1 在无输入时不断重画提示符，未到凭据接收端、未读取
  密钥。两种真实引擎的独立作用域探针均证实：启动脚本局部模块变量在脚本退出后的全局
  回调中为 BadExpression，显式闭包捕获模块对象则得到实际私有函数值。
  后续 `a6ab9355` / `e09f2104` 的 PS7 不再提示符循环，但尚未产生就绪能力，仍 FAIL；
  真实普通用户只读命令进一步定位了 OnIdle 任务错误；当前事件动作使用返回事件任务的
  私有 Module.SessionState 绑定实际集成对象。普通全局回调保留受信模块归属，通过
  冲突检查后的稳定集成引用调用，保持既有后台任务的用户模块限制，不移除 ReadLine 栈门禁。
- Windows `e6db99c6` / `97bf704d-c023-4c2a-9ca0-13be0e2917c1`：实际 Session1、5.1.26100.9711、
  PSReadLine 2.4.5 的无模型 native-inline/ready 启动通过，无草稿/操作/恢复门禁，原数据
  未变。独立路径探针证明同 SHA 的 Polyfiller 文件实际存在：5.1 在 268 字符路径加载
  FileNotFound、181 字符路径加载成功；7 两处均成功。私有 cache 改为短 `editors` 名称，
  保留完整内容身份，仍过长时明确拒绝 native preparation，不改系统长路径或执行策略。
- 无密钥取消 `dd2513fb-d7ca-4c12-bb55-7711b3a6d666` 已到真实 receiver-ready 后命中
  取消：原 worker、CLI、镜像真实退出，独占 DB/pending 恢复清单 references=[]，0 密钥读取
  或传递，原用户数据未变。该预期取消的 worker 非零不是模型成功；取消目标本身通过。
- 临时凭据轮次 `6597fbdb-d724-4ab8-8cb2-d81e4dc95db8` 的两个模型应用仍 FAIL，后台命令
  在输入前因未广告 nativeJobControl 被拒绝。正常保存后已完成 OS 删除和正常 API 缺失
  清理，原用户数据未变。新版本在取密钥前即要求该模型用例所需 nativeJobControl；
  不把用户未知模块加入允许列表。
- Mac 交互轮次 `a7166797` 的真实模型使用不存在的 `inputinputKind`，schema 原样拒绝，
  不归一化或重放；新独立上下文明确合法字段补验。取消轮次 `6c70fde2` 在模型输出上限
  处结束，0 call/0 lease/未进入 native 输入，不计取消通过；后续仅缩短独立测试程序的
  字面常量，未修改模型全局配置或 native 5000ms 期限。

## 当前 Linux 生产 SSH 补验

`c8324dd8` 全新容器 `a8238143-565b-49d9-a37e-499a6683bea7` 真实重建 DSO
`a042151448973eb25a65fa1c183f08861a1a998ab2e6bd33dcc46e785fe20cf1` 与 relay
`d05c9e24a61ba132721354816f1da71c183fde40f39e5ebc88ce6a694bbb2953`；生产 SSH exact test
1 passed/0 failed/0 ignored，6 操作通过，临时凭据已删、账户已锁定。
`90624be4` / `production-ssh-zle/7aac4605-8c76-4cb3-b1b1-9007f07e199e` 的新独立 fixture
进一步执行 8 操作：真实 JobObservation finished/143，实际远端 Python `os.killpg(pid,0)`
得到 ProcessLookupError/ESRCH，临时凭据清理与账户锁定通过。该测试包含输入中 resize，
仍不证明在 resize 前已实际软换行，也不覆盖完整浏览器/原生窗口几何矩阵。

## 隔离的通用终端库研究

`xterm-el-experiment/8479c9d8-b3fd-400d-ac10-83b375ec8168` 以固定的官方 xterm 6.0.0
源归档与锁文件重新构建，唯一额外实验改动是 EL0 在显式 reflowCursorLine 模式中保留
既有软换行关系；EL2 行为未改。`xterm-el-comparison/26c56cdf-4009-44d1-830e-84cfdef42e7a`
保持实际原 PTY 字节、180×30 几何、源码与真实 BUFFER 摘要不变，八个组合中仅候选规则+
官方 Unicode11 0.9.0+reflow=true 的原文 copy/search 同时为 true，公共 API 均未覆盖。
这仅是本任务构建的 upstream Zsh 5.9 paired ZLE、私有 combining-chars 配置的离线可行性，
不覆盖绑定的 Apple `/bin/zsh`、动态 resize、WebKit/WebGL 或真实 Agent 输入路径。
正式 xterm 补丁仍为既定摘要，依赖、provider、用户配置和实际 Shell 绑定均未改变。

## 当前持久化与取消补验

Mac `60d3ed04` / `9bef7ea7-7cea-4c0e-8a98-638ac103ab4e` 的真实模型取消已通过：公共
xterm SearchAddon 实际找到部分源前缀、私有阶段为 typing 且未完整确认后取消；真实
DraftCleared、mayHaveSubmitted=false、durableIntent=false，无效果文件及晚到提交，普通用户
命令执行成功。最终 pending/recovery/clearPending 均为 false。重复取消在观察到真实清理后
不再发送第二次 clear；真实 Bash 回归同时覆盖该重复清理入口。

Windows `25d4de78` / 临时凭据轮次 `c81936a3-7849-4eb9-8847-76236aa32d97` 两个应用
仍 FAIL：PS7 在 kill_process 返回 SQLite 15；PS5.1 在 wait_process 返回 scratch 原子替换
的 OS error 5。启动及 nativeJobControl 已先通过；本轮临时凭据完成系统删除、正常 API
缺失检查及原用户数据未改审计。两种存储错误分别诊断，未将磁盘健康或路径长度推断为根因。

实际生产 journal 并发探针在 Windows 旧版本复现 49 次失败、18 条未结记录；保留该旧目录。
增加 journal 局部 I/O 门闩后，新独立 Windows `7d89f8f9-e7da-40ad-b76b-5c1e5044bb82`
及 Mac 各 800 次真实磁盘操作均 0 失败、0 未结。FULL、NOFOLLOW、唯一调用围栏和原 busy
timeout 保持；无重试或自动重放。就近回归加入并发写入、重复围栏拒绝、重开及实际
800/800 settled 磁盘计数，当前 `journal-concurrency-regression-tests-fixed.log` 为
13 passed、0 failed、1 专用崩溃子入口 ignored。独立探针仍使用冻结 Windows 应用的
rusqlite 0.40.0；当前 owner 回归使用其实际锁定的 0.40.2，不能混称同一依赖版本。

scratch 的现有路径检查、写入、sync_all、tempfile.persist 与 Unix 目录同步原样拆入
`scratch_storage.rs`，由实际 runtime 和独立探针共同使用。Mac 16,000 次真实并发读写
0 失败，6 个 scratch 测试通过、1 个真实 SSH 用例 ignored；Windows 探针尚未运行，后续
连接在 SSH connect 阶段超时。这不是 Windows scratch 修复通过，也未增加猜测性重试。

## 当前动态显示对照

候选完整 upstream Zsh 5.9 的 `77640c39` / `ba8d0097` 实时 native 用例未通过全部门槛。
进一步的 `e79a6eaa` / `live-geometry/0c91fb44-4175-44e7-a92e-5d0a111d59e9` 保持
同一 Shell、候选 EL0 规则、Unicode11 与私有 combining 配置，仅在独立诊断用例停止后台
持续输出：四种起始列宽均实际观察软换行后执行七次 resize；32/40/180 列组件通过，100 列
因未观察到后台 settled 而 FAIL。四轮完整源 copy/search 全部 false，仍不替代后台输出要求。

`e2c4de9c` / `live-geometry/c6201e52-d874-4414-9bbb-a9c61b528b97` 是同候选 Shell 的
普通用户实时键盘输入对照，无 native adapter、未执行源命令。四种起始列宽均实际观察
软换行后完成七次 resize；真实 BUFFER/游标与完整原文一致，copy/search 全部 false。
原始字节和公共 cell 里可见 ZLE 的 `>....` 超屏截断，与该上游 `zle_refresh.c` 的
scrollwindow/more_start 路径相符。普通对照也失败不豁免 native 的完整复制硬门槛。
此研究没有修改正式补丁、provider、用户配置或实际 Shell 绑定；P3 显示条件保持未通过。

## 当前 ZLE EOF、映射与显示退出

本地 EOF 清理先重新读取真实 BUFFER/CURSOR，只清理仍与当前草稿已应用前缀逐字一致的行；
已接受但尚未交回父解析器的行，同样要求真实清空及零游标观察后才退役本地 Enter 保护。
曾接受、连接失败和后端持久围栏保持，不发送伪造 DraftCleared，也不授权重试。
只有函数体/控件仍属于本集成时才移除注册；用户改函数、改键及重新连接 main 映射均保留。
实际映射从公开 `bindkey -lL main` 的 `-A` 目标保存，避免 main 改指向后漏清旧映射。
最终 line-finish 在用户钩子之后重新读取私有通道，拒绝新观察到 EOF 的交接。

`7be0f472` / `geometry-capture/8c4b18e4-ec55-4b1e-bc20-9de1a3d97564` 七场组件通过：
idle、typing、armed、returned、user-changed、user-map、user-draft。私有清理没有覆盖用户
中文草稿或新函数/键位，旧 emacs 绑定已清理，main 仍指向用户选择的 viins。

`146311d7` / `geometry-capture/78cdc567-77ba-422a-8c87-304d385295d5` 十场组件通过。
其中 accepted-before-parent 使用预先冻结的公开用户 line-finish 钩子与真实 FIFO 门：
一次实际接受键、实际 SubmissionAccepted、完整真实 gate-buffer/游标及 pending=1 均已观察；
关闭通道后才释放 FIFO。随后真实空草稿、pending=0、效果文件不存在、普通用户命令成功。
该轮记录为 possiblySubmitted / noSubmissionJournalProofClaimed，不能替代 App/Broker 围栏验收。
两个实际键/EOF 并发场次同样保留 possiblySubmitted；未收到接受回执时不声称已经覆盖接受缝隙。
旧轮次 `mayHaveExecuted` 仅区分断连不明场景，不能把 returned 的 false 解读为从未执行；
新记录使用 agentOperationAtDisconnect 区分 settled、possiblySubmitted、notAccepted、absent。

清理统一发出 display-off，避免绑定变化或最终交接 EOF 路径遗留 owned 显示模式。
`93bf450c` / `geometry-capture/ffe073ac-036f-49e6-a55c-3dd4c4a3c9fb` 十场真实 EOF
复验通过；`eof-browser/0995a255-06b9-4107-b4f4-441eab7e7e5b` 对这些原始 PTY 在 Chromium、
WebKit × dom、WebGL 共 40 次检查均通过。销毁 display 前 reflowCursorLine 已为 false，
公共 API 未改、未产生输入；不是借销毁时的兜底恢复通过，也不证明完整 Unicode 复制或 App 恢复。

上述各组件轮次均检查完整源清单、复制的测试镜像与原生资源直至实际进程退出。当前 Mac
DSO 为 `7e68c3413d9be772f82a29615ceb683500180b969996265e4939d0e80e7da6a1`。

## 当前中断窗口与生产 SSH 复查

`c84f68e3` / `geometry-capture/21c79d16-d0a0-4816-90f6-22c06a9d2f92` 的四种宽度
running 中断组件通过，共 36 操作；handoff 轮次在 Started 后立即发送 Ctrl+C，实际采样
前台组仍为 Shell，未得到 Settled，超时 FAIL。该记录保持，不把仍运行报告为已停止。
独立普通系统 `/bin/zsh`、无 provider 的 `ordinary-handoff/fd592c94-144b-4d1b-88a7-312b94cb4e76`
对照十轮均在 preexec 标记后采到 Shell 前台组，Ctrl+C 后 750ms 未返回提示符；该基线用于
理解窗口，不豁免 App/Broker 的不明结果、输入围栏、无重放、明确恢复及真实进程清理要求。

`bc0b76c9` / `production-ssh-zle/46dda32e-4916-47fa-9007-79598fb49a1b` 的全新 Linux
生产构建与 SSH 八操作通过，实际 finished/143、进程组 ESRCH；临时钥匙串凭据已删、账户已锁。
该轮 Linux 模块 `300ec67503131a5ad1dec4e946e7c5562584e545f7a3d47464bb01f692571be4` 对应
此前 EOF/映射源码，尚不覆盖随后本地 accepted-discard、line-finish 重读和统一 display-off 改动。

真实 App/Broker 提交后故障入口已经准备：只在独占 HOME 中使用公开用户 preexec、局部 INT
trap 和一次性 FIFO 门，实际模型只获批执行冻结的诊断程序。诊断程序记录真实 PID/进程组、
继承信号状态与实际进入计数；用例要求未确认停止后仍保留 Uncertain/RecoveryRequired、
输入阻断、单条未结 SQLite 意图、旧身份拒绝、实际进程组清理与显式新终端用户恢复。
目前仅静态及 TypeScript 检查通过，尚未执行该 App 用例。最新 CUA 直接报告 Mac 已锁定，
已请求用户再次手动解锁；Windows SSH 仍在 connect 阶段超时，原凭据授权不重复请求。

Linux `2e600c35` / `production-ssh-zle/e5312889-9c98-4546-9cae-23b33e1a7229` 的更新轮次
通过八次完整操作，再追加一次实际未提交前缀：仅关闭生产私有 SSH/relay 通道，实际 PTY
观察到新 owned 显示区间结束后，普通用户命令确认 native 自有钩子已清理、无 late-effect，
用户 SSH PTY 仍可用。真实 finished/143 与进程组 ESRCH 保持；新临时凭据已删除、账户已锁。
此轮 `plannedOperations=9`、`completedOperations=8`，不把未提交准备算成已执行工具。

名称保护回归 `65746785` / `geometry-capture/ecf36be6-8695-4587-9657-b864dd360dd9` 中，
原保留函数已正确拒绝，但实际保留别名未能正确拒绝，原 FAIL 保留。保护扩展到公开的函数、
别名及 widget 名称之后，`f83dac08` / `geometry-capture/fd3426cc-a30b-4f95-b7dd-3e4ef72a3ded`
四场（function/alias/widget/chord）通过：真实控制连接拒绝、未广告 nativeInline，用户原定义
逐字保持且观察控件/普通解析器可用。仅为明确私有名称冲突的组件证明，不能外推 P4 全部 raw
迁移或 Windows 自定义 PSReadLine 负例；更改后正常 EOF/SSH/App 的最终同版本复验仍须完成。

`f83dac08` / `geometry-capture/5c154886-561a-423f-b38b-b5568dfa3fdd` 已完成名称保护变化后
正常十场 EOF 复验，结果通过；App/Broker、Windows 和完整显示门槛仍未完成。

根会话同主 Shell 的 `root-system-editor-probe/a94f3008-7168-4254-ab99-8888784bd563` 仅在
独占新进程/私有 HOME 中通过公开 zmodload/module_path 加载未修改的 paired upstream5.9
ZLE 核心。`/bin/zsh` 主程序 SHA 保持，lsof 记录实际映射文件，短 ZWJ 原生 BUFFER 与字节
一致、未执行源命令。该局部 ABI/宽度研究不是正式 editor 替换或完整动态/语义兼容通过；
正式配置、provider、补丁及用户 Shell 绑定均未改。

名称保护后的 Linux `02565088` / `production-ssh-zle/ac99e1b8-bfd5-4931-9be6-d12e8b5799ce`
再次通过八操作与第九次未提交 EOF；真实 143/ESRCH、用户终端恢复、临时凭据删除及账户
锁定均确认。该真实 producer 的源输入与当前 owner 逐项相等后，Linux 资源已导入任务缓存；
导入步骤复用该次实际构建，不代表导入时再次编译，也不代表最终跨平台验收。该轮和本轮
另外两个已完成的自有 Linux 容器已停止，保留容器及全部源/日志，不触及其他容器。

App/Broker 故障入口进一步要求类型化 `write_session` 的真实后端拒绝、拒绝前后输入序号
不变及实际 PTY 未收到公开哨兵；运行中的旧 controller 和新 controller 均检查公共 API
身份。实际进入计数与程序 SHA 还会核对至 App 退出，旧未结 SQLite 意图不得因新用户终端
恢复而消失。入口预检通过不代表这些动态断言已通过；原生桌面解锁仍待完成。

`0fe049de` / `geometry-capture/0b9feae7-271a-4e74-8fed-91cd5d221d8c` 的十一场通过：新增
完整输入确认之后的真实用户 widget 修改，再断开通道。原生修改后的 3038 字节在断开前后
逐字相同，未误清外来修改；随后真实用户 Ctrl+C 与普通命令成功。对应
`eof-browser/179816c0-096e-417f-b2ce-1f9116c68714` 的 44 次显示销毁前检查通过。

全局别名独立存在于公开 galiases，保护检查也已覆盖；`2fbeaf15` /
`geometry-capture/ffe5647f-a19b-470e-8d3e-325e18605cf8` 五场名称冲突通过，包含真实 global-alias。
`93329f12` 新扩展故障模具先因错误使用不存在的枚举名而编译失败，未运行任何 native 用例；
原件保留。按实际 Rejected/DuplicateRequest 类型修正后，`3cb051f7` /
`geometry-capture/a9915d37-ed3d-4f43-b787-dc1e54a3e239` 十四场通过：新增非法 UTF-8 控制帧、
真实半帧 EOF，以及同一实际 commit/接受键重复注入。重复场次有两次测试键写入，实际接受
回执只有一次，收到 DUPLICATE_REQUEST，真实效果文件一字节；这是 native editor 重复保护
负例，不是生产 Broker 发送两次键，也不替代跨 generation 的持久围栏/App 验收。
协调会话随后对该封存版本补验 `zle-eof-browser/45b922fa-e6bf-4876-a1b6-81f58ea6d40d`：
Chromium/WebKit × dom/WebGL 共56组合通过，销毁前后显示选项 false、接口未改、无输入响应；
正式5aabb依赖通过整目录软链接复用。仅证明该旧版本显示退出，不外推新的 scoped core。

## 有界原生 Core / NIP 受控候选

正式 owner 加载器、Core、provider、补丁和用户配置均未更改；只有新增实验管理/审计脚本。
实验通过 `scoped-candidate.mjs stage/revise/seal` 在新完整源码副本修改，先明确未封存，再
记录全部覆盖并封存；旧副本及失败结果不回写。每轮使用复制的实际测试镜像，验证完整源码、
主程序、core、适配器与生成资源直至真实退出。实验 profile 不扩大正式 allowlist。

使用根会话 producer `root-zle-scroll/d64b4c85-f445-4bf0-94ff-feb7f2433d1c/producer.json`：
实际主程序 `/bin/zsh` SHA `abc56520...` 不变，私有 core SHA
`521e7ca22ecc1727d059d13f5034df71ac0eca88a176c09d5bfc59c0e46c87fc`。
新的公开 widget-local `ZLE_BUFFER_DISPLAY_LINES` 默认0、合法0..16384、zleread 生命周期
归零，正值才扩展原生缓存并使用 scoped libc 宽度/combining；不改 COLUMNS/LINES。
候选加载前与复制后检查 core SHA，Native Adapter 再通过公开新符号 dladdr 验证实际映射路径；
测试同时记录实际子进程 lsof 映射。没有使用私有 ZLE 结构、printf BUFFER、-M 回显或前端拼字。

NIP 只在当前同线程 validated/owned、未接受且未交回父解析器的真实草稿提供只读完整源码
字节数。Widget 更新 BUFFER 前据此及实际 `/dev/tty` ioctl 几何申请容量：源码字节数+
真实视口行数+34，最大16384行且不超过2097152个缓存cell；小于8列明确拒绝，避免Tab上界
不足。初始 BUF 空及每次前缀所有权仍由真实NIP生产者验证。取消/EOF/失败恢复原作用域；
接受后的 Core 生命周期自动归零，下次普通编辑检查为0。新增输出数值由 widget 局部变量接收，
新作用域参数和输出变量同名冲突在修改前拒绝，保留用户值。所有变化仅在实验副本。

| 实验源码 | 实际结果与限制 |
| --- | --- |
| `61ef3392` | 首版构建完成，封存后发现作用域参数冲突和小列宽边界，保留；未当作最终兼容通过 |
| `a14f051a` / scoped-runs `f2455019` | 真NIP九操作通过，持续后台输出、长Unicode、parent变量、后台143/ESRCH、执行中Ctrl+C；scope samples0..1930，普通后续getter0，实际私有core已映射 |
| 同版 live `3b0a198c` | 32列七resize但完整复制失败；40/100/180最终复制搜索true但0resize，整轮FAIL |
| `2966c44d` / guards `4b16c5ba` | 十场真实名称/新增参数冲突通过；EOF `d1ab4021` 在viins下未绑定诊断键而失败，不作为生产清理故障 |
| `4bd39e55` / live `7b0506d6` | 完整真实BUFFER最终调用公开redisplay；32/40均九操作+先wrap后七resize+原文copy/search；100/180门到达太晚，整轮FAIL |
| `8b32452c` / EOF `0a20fec9` | 修正真实viins诊断绑定后十四场通过，全部末次getter0；协调浏览器 `54100811` 的56个正式runtime显示退出检查通过 |
| 同版 live `bbdeb181` | 已扩展十二操作（false/前状态1、多行、减少动画真实Tab）；100/180十二操作和七resize+全文copy/search通过，32/40没有及时观察到连续前缀，整轮FAIL |
| `9a4bc8ba` | 不改native行为，观察器改为只读公共cell逐字检查同一完整ASCII前缀及真实isWrapped；没有据此放松最终copy/search、typing query或真实resize条件 |
| `acd41a13` / live `0427d1c5` | 读取R之后的实际BUFFERLINES才判断第一次换行；32/100/180十二操作、七resize、完整copy/search通过，40仍0resize，整轮FAIL |
| `39eea3c0` / live `651d9439` | 按实际已绘制行数增加触发原生重画；32/40/100/180四场各十二操作、先wrap后七resize、长Unicode全文copy/search均通过；EOF十四场、名称/参数保护十场通过 |
| `56924c2b` / live `15f8bd26` | 用户原有env先读取一次，已有早期Core时拒绝native并保留正常profile/rc/login；保护十一场通过。新增实际CR后四宽度各十三操作、七resize及长Unicode全文copy/search通过 |
| `1c69fc60` / Core `baf38d00` | 正预算下强制重画完整逻辑行末glyph；正常十三操作通过，但character `723cf823` 仍只有8/12合法复制，Tab未修好，保留FAIL |
| `3e614bfb` / Core `9e38b0b1` | 正预算Tab跨行分支补真实尾space；正常十三操作、EOF十四场、保护十一场通过。live `abc4c598` 四宽度各十三操作、七resize、长Unicode全文copy/search通过；控制字符12项合法复制通过，默认0对照12项原始cell/换行/copy与stock一致 |
| `11a7cf12` / provider scope | 可选provider仅随真实owned显示起止切换并恢复；四renderer cases共124 assertions通过。live `b912fcdf` 四场各十三操作/七resize/全文copy/search，owned时实际11、销毁前已恢复6；真实EOF同native源码回放56组合通过 |
| `279a4432` / typed metadata | 后端校验Core后生成可选unicodeVersion，经Broker快照、SessionPtyInfo类型到registry；官方addon0.9.0只按需注册，普通默认不激活。完整frontend build、Mac适配器实际重建及十三操作通过；随后发现本地wait入口仍构造旧binding，原版封存保留 |
| `ddfc4856` / actual Broker binding | 快照和本地wait共用生成函数；真实ZLE/Core/私有Capabilities经Broker校验，两个入口和SessionPtyInfo序列化均得11，协商前binding为空、无操作/提交意图，实际进程/进程组ESRCH。不是原生窗口或registry运行时验收 |
| `9ebdba49` / resource manifest | 引入结构化core/license及固定源码配方校验；旧SDK复制树的时间戳导致make尝试调用autoconf而失败，保留，未作为清单加载阳性 |
| `1cd0e724` / packaged Core fields | SDK改为每次从固定归档全新解压，适配器实际重建；清单声明Core/license路径及摘要，实际Broker到Session DTO复验通过。完整prepare因其他平台旧FFI源摘要失败，未放宽门禁 |
| `7069f6e4` / manifest path guard | 读取清单时先以Path::components及明确ASCII profile组件规则拒绝绝对/父路径/分隔符；真实正常清单通过，六种非法ID在read_catalogue及prepare均返回MANIFEST_INVALID，未扩大重测 |

公开cell观察只读取真实PTY渲染结果，不写入任何文本、不包裹接口；最终复制/搜索仍使用原始
Terminal.getSelection 与 SearchAddon。协调独立128-byte回放 `root-prefix-cache/966f8560`
对旧r5四场发现公共cell与原Addon首次出现前缀的offset相同，无cache差异；因此继续修正原生
早期连续前缀，未以缓存假说豁免失败。全部input预算5000ms、原1200ms动画规则保持，未暂停BG。

R8 EOF组件为 `scoped-runs/1bdfb65e` 十四场，名称保护 `552380d7` 十场。协调会话独立
EOF组件 `cdd98067` 也通过十四场；其首次浏览器因同时发现两轮共28场、预期仍为14而退出1，
原结果保留。按明确清单选取原十四场后 `root-eof-inputs/aae30da5` / `eof-browser/1bc8791d`
共56组合通过。协调额外 `root-scoped-renderers/b57014d0` 的16组合回放通过；这些回放
不增加LIVE场次。`root-full-source-caret/80edf205` 在首个完整源码帧读取实际公共光标等于
真实选区末端，未使用光标覆盖。仍观察到历史中重复的部分prompt/source，尚须与普通原生
编辑器同条件比较，以及检查稳定画面、滚屏和闪烁；不能将最终全文搜索成功当作这些检查通过。

R9 `scoped-runs/dc3768f9` 正常十三操作通过，`4f3c924d` 保护十一场通过，实际测试镜像
SHA `d2d623c166110966ab9e33866dbc098f3f6bccb0a53aedf9e165789e23b36c2f`。
每场source-corpus只记录预期请求，并逐项匹配真实生产者完整BUFFER证明。第10项包含两个
真实LF，第11项包含两个真实Tab且reducedMotion=true，第12项包含两个真实CR且
reducedMotion=true；不是反斜杠字面量。R8独立 `literal-character-audit` 同样确认LF/Tab
摘要和UTF-8字节数。字符执行语义及BUFFER一致已证明，控制字符的实际cell/合法Tab复制
仍须独立验收，不能借用长Unicode源码的复制结论。

Linux受控 `22530006` 使用同三份公开Core修改源码，针对实际Debian主程序保留glibc
默认宽度（--disable-unicode9），主程序SHA `1ebc9b70...`，实际Core SHA
`a8e6af1751759e20365d8a047a10972bef3b4e4bec567d120ec8058b56fda001`。
`production-ssh-zle/f94dfa82` 八操作和第九个未提交EOF通过，实际/proc映射私有Core、普通
后续getter0、finished143及进程组ESRCH确认；临时凭据已删、账户已锁。
`scoped-linux-baseline/1d88647c` 的真实普通PTY stock/scoped-default两场通过，确认Unicode
变量和草稿、前状态1、Ctrl+C空草稿与真实100×30不变；该普通对照不声称NIP或模型通过。
新Linux修订 `8588ab40` 重建在发布自己的继承只读产物时失败，未运行SSH；原件保留。
`7bdd23b9` 修正新副本产物的发布权限后构建完成，八操作及EOF通过，但追加启动负例复用
已关闭交互PTY的旧SSH transport，在第二次SFTP startup失败。原FAIL保持，临时凭据删除、
账户锁定均通过。`c4de0ec9` 在同一固定主机密钥下为独立启动负例建立独立真实transport，
`scoped-ssh-runs/a3c0b071` 通过：八操作、未提交EOF、早期用户Core/widget保留、原env及
profile/login各一次、native拒绝、实际system Core映射均确认。该轮复制实际测试镜像SHA
`c31b1827781d9c21124209efa6c908670237edc57719f714cc297dfc8d650f25`，完整1943源文件和
资源核对至退出，凭据删除、账户锁定、cleanupErrors空；实际证据 `production-ssh-zle/8684bff5`。
中间 `ae4f46c2` 仅封存未运行，因继承只读输入需要无重写校验而建立后续修订，未修改旧副本。

`scoped-character-browser/1ccd24fe` 以真实普通ZLE quoted-insert逐字输入为对照：三项真实
BUFFER分别匹配R9 LF/Tab/CR摘要，全部未执行。Chromium/WebKit × dom/WebGL 共12项
实际可见cell完全相同。R9 LF保持真实换行、CR按原生^M可视约定复制，共8项满足合法复制；
只有Tab的4项失败：第一处Tab恰推进到40列边界，原cell正确但后继行isWrapped=false，
复制将A后七空格变为A换行B；普通ZLE也失败不能豁免Agent门槛。未更改selection/search
公共API、未输入源字符串到renderer，也未删除该断言。早期 `98595bb1` 的普通LF长搜索
token跨硬行导致边界查找失败，`03359310` 的末端token不唯一导致Tab/CR提前结束；后续只
修正观察边界，原FAIL均保留。

独立Core producer `2c35f2c0` / SHA `baf38d00...` 的首次末glyph修复仍不满足Tab，原件保留。
重新从原Core三文件建立的 `7a9c20bb` 只在refresh的Tab跨行分支、正预算下按原生属性填充
rpms.s到rpms.sen的真实space，再调用现有nextline；默认0走原路径。实际Core SHA
`9e38b0b15228aa86bd20a240c0034c3340c7846778babb53f99f1a1f79043ceb`，refresh源码SHA
`c694ba6b44004c1b8fc66ce692cb5fc85903fd9104b13bd888a10c23c0e48661`，另两份源摘要保持。
根会话原Core、主Shell、正式资源及全部旧产物未改。

新封存NIP `3e614bfb` 的实际镜像SHA
`10565c50559c18d6964916a0c95727b709f1e6be9634aeb74657b03f1833d8a8`，完整1943源文件。
`scoped-runs/7f7c7061` 十三操作，`d02bce11` 十四EOF，`209bc588` 十一保护通过；均检查
真实镜像、主程序、新Core、适配器及完整源/资源至退出。实际映射检查保持。
`scoped-character-browser/615a7ee0` 的12项合法复制全部通过，原始cell相等只有8项而退出1；
差异精确为Tab处七个旧width1空cell变为新width1真实space，符合修复目的。原FAIL不回写。
后续 `cb236bdd` 同时保留原始cells和原始相等结果，并仅在测试观察层把width1空cell与
width1空格视为相同可见字符：12项合法复制及12项可见字符通过，原始相等仍明确记录8项。
没有改写任何复制或显示API；预期Tab文本由Python标准expandtabs(8)按真实prompt列计算。

新Core默认0通过真实/bin/zsh、私有HOME、原quoted-insert输入：`557b01d6` 的三项
LF/Tab/CR均观察实际预算0、原样BUFFER、原游标/真实40×30与实际新Core映射，未执行源。
`scoped-default-compare/cc95c473` 将这12组普通对照与stock `cb236bdd` 的普通对照逐项比较，
原始cell（含wrap flags）及原始copy全部相等。此结论仅覆盖这些普通编辑控制字符，不外推
完整默认Unicode/语义/ABI。`live-geometry/abc4c598` 四场各十三操作、先wrap后七次实际
resize和长Unicode复制搜索通过；稳定画面/历史残留等限制仍保留。

Linux `c478db6a` 已用同一 `7a9c20bb` 三份真实源码重建；保留实际Debian主程序及默认glibc
宽度，新Core SHA `f1c104f49aa0974e609c3ca37f181c6581ec2b9a16cbf33364cce5d9561ba754`。
`scoped-ssh-runs/d053e831` / `production-ssh-zle/82509116` 通过，实际镜像SHA
`09f7512859e25419ebd325c566baa7d8ec5b19d04786afd914cc13b63418ec90`。八完成操作加第九
未提交EOF、实际143/ESRCH、映射、getter0及普通用户恢复均确认；长Unicode操作另含两个
真实Tab及实际变量相等检查。早期用户Core/widget保留与原env/profile/login各一次保持。
完整1943源文件、镜像及资源核对至退出，临时凭据已删、账户已锁、cleanupErrors空。
`scoped-linux-baseline/340e3956` 的stock与新Core默认0真实普通PTY两场通过，覆盖Unicode
变量/未执行草稿、前状态1、Ctrl+C空草稿和实际100×30；不声称Linux四宽度renderer通过。
本轮及前述四个自有Linux容器均已逐一核对标签后停止并保留，未清除镜像/容器或影响其他容器。

## Provider作用域、类型化接入和可复现Core源码

`11a7cf12` 在显示模块增加可选已注册provider配置。未给配置时不访问unicode API、不改变
普通默认；首次真实完整enter保存原值，重复enter不覆盖，exit/transport-reset/有序关闭/销毁
恢复原值，并保留期间显式发生的外部provider切换。操作通过公开unicode.activeVersion属性，
不覆盖selection、buffer、open或provider注册接口，不修改执行状态或发送输入。
`scoped-provider-browser/cb7ba646` 是4个真实renderer cases、124 assertions（不是124 cases），
使用正式5aabb及官方addon，全部通过。
`live-geometry/b912fcdf` 的四种真实宽度各十三settled、七次实际resize及全文copy/search通过；
wrapped.providerVersion=11，providerBeforeClose=6且providerRestored=true，显示状态和接口身份
不变。实际测试镜像SHA `195f7eb0f1040ccfcad026c7dcd521abbb4eb2b94cd0fed9ebbabfb9aef7ac43`。
`scoped-provider-eof/27e9b20a` 对R11的14个真实EOF在4renderer回放，共56组合通过；逐项确认
native相关源码及Core与新display候选相同，销毁前后provider6/reflow=false，不冒充新native
执行或全源码同版本App验收。`scoped-character-browser/2b6e5b66` 直接编译新候选display源码，
按真实owned标记切换，12项合法LF/Tab/CR复制、可见cell及provider恢复通过，rawCells仍保留8。

类型化修订 `279a4432` 中，VerifiedNativeProfile只在实际Core路径/摘要与受控ZLE目标吻合后
产生可选unicodeVersion；PeerProfile、OSC或前端ready不能授予该事实或执行权限。
Broker快照经既有SessionPtyInfo字段传到registry，registry只按该后端字段注册官方addon并把
选择交给display scope，加载addon不激活普通provider。该候选新增精确0.9.0依赖，lock仅新增
该包三处条目，未更新其他依赖；frozen install、完整TypeScript/Vite build及Mac原生重建通过，
新适配器SHA `251484522041be0f19a8141497b208ca104e4599f7b64dc2cf3f9738c68ff030`。
正常 `scoped-runs/d2c83153` 十三操作通过，实际profile binding得到11，真实错误可执行文件
作为Core被拒绝。检查实际local session创建入口发现wait仍返回旧binding，故该版本不是最终
Session接入验收，未修改已封存源。

`ddfc4856` 将Broker快照和local wait改为共用同一后端binding生成函数。
`scoped-runs/7beafd81` / `broker-display-binding/ab5d74e1` 通过，实际镜像SHA
`a374e9cf8737c399baf01d28884af65912de0bcebd0d6005a0198b1eb1338ce4`。
真实/bin/zsh和私有Core启动，真实NIP capabilities/readiness经生产Broker处理；协商前仅
准备Core时没有binding，协商后snapshot与wait相等，实际SessionPtyInfo JSON有unicodeVersion11。
没有创建Agent操作、接受键或SQLite提交意图；仅显示协商不能创建operation coordinator。
实际Core映射、PID及进程组ESRCH与完整1943源/镜像/资源至退出均确认。registry已实际编译，
但实际Tauri Session/registry窗口运行时仍待Mac解锁，不将DTO测试冒充该验收。

新的可审阅源码配方位于 `scripts/dependency-builds/zsh/pin.json` 和
`scoped-display-v1.patch`，构建入口 `scripts/native-input-p3/build-scoped-core.mjs`。
从官方9b8d归档重新解压、标准patch工具零fuzz应用补丁，三份实际C源码摘要逐项匹配，再
按目标原有宽度配置构建；不安装用户Shell、不写用户配置、不启用生产profile。
`pinned-core/377bc596` 完整Mac重建得到相同Core SHA `9e38b0b1...`，实际/bin/zsh摘要保持，
LICENCE随候选保留。源码补丁SHA `20cdab614b03877df785e02f0875ad399ad71ba152160dbaa34466a1616a5715`。
因此构建不再依赖实验目录里的手工C修改；跨目标资源目录/源码打包接入仍待完成。

## 清单资源接入与当前打包门禁

`1cd0e724` 的清单按profile声明 `core=<id>/zle.so`、`editorSha256`、
`coreLicense=<id>/LICENCE.zsh` 及许可证摘要。读取端约束ZLE类型、固定相对路径、摘要格式，
并用编译期包含的pin/patch/build入口摘要拒绝陈旧配方；本地加载按清单路径读取，实际复制后
校验并绑定已审核Core，私有ZLE映射路径保持。构建器仅在显式给定实际Core producer时生成
该扩展，校验实际Core、主程序、pin、patch和三C源码，不依据自报版本启用profile。
标准资源preparer已接入Core/许可证复制、官方归档及源码配方打包，不跳过其他平台或Bash的
原有源摘要检查。Linux导入辅助入口也携带清单声明的Core/license并核对固定归档，尚未导入
这些新实验产物到owner生产缓存。

首次 `9ebdba49` 从旧配置SDK复制树构建，因文件时间戳顺序触发autoconf而失败；修订版每次
从同一9b8d发布归档重新解压SDK，运行原GNU89配置和构建，没有安装额外工具或伪造时间戳。
`1cd0e724` 实际Mac适配器SHA
`1fbf88d13eb568c47b18cf839616f70c1fa0ab734e5bb7fc6d452e7515428696`。
`scoped-runs/b01cc5b3` / `broker-display-binding/e7de5e69` 再次通过实际Core清单加载、真实
Capabilities、Broker snapshot/wait与Session DTO一致，以及实际PID/组ESRCH；镜像SHA
`1cd638b9aa8d98f93e592e681549c42cf28e1efc2a2df6fdd65815eb69a3d003`。

完整 `prepare-native-input-resources.mjs --no-build` 原件仍FAIL：其他缓存平台清单的
`src-tauri/native-input-editors/src/ffi.rs` 摘要为77f237...，当前实际源为1026bab...。
日志在该候选 `.native-input-p3/manifest-core-package.log`，未修改旧产物声明、删除检查或
过滤失败平台。完整可分发包尚未通过，仍需各真实目标重新构建并完成同源矩阵；新字段复制
代码和单一Mac清单加载阳性不替代这个门禁。

路径边界修订 `7069f6e4` 在任何清单派生的artifact读取/复制前，将profile ID限定为一个
可移植路径组件：std Path::components的Normal组件、首字符字母数字、其余仅字母数字点和
连字符。原合法ID保持；不把后续verify_editor精确ID拒绝作为前面的路径保护。
`scoped-runs/394aa768` / `manifest-paths/b90364f1` 通过真实正常清单与六种恶意ID变体，
包含父路径、绝对路径、嵌套路径、父路径组合、反斜杠和Windows驱动器形式；实际read_catalogue
和prepare都在artifact I/O前返回MANIFEST_INVALID。该负例改写真实清单输入，不制造原生
控制回执或执行证据。实际镜像SHA
`36c0543b9657504a8952acce4750414244990d572d9fc3fdea38eec93f800e0b`，完整1946源/资源至退出
核对。未重新运行未受影响的四宽度/EOF/默认0行为矩阵。

此前续接记录：`.native-input-p3/p3-checkpoint-20261102-061652.json`。随后owner已同步下面
列出的默认资源/后端准入门禁及路径保护；Core加载、provider和registry新功能仍在完整隔离
候选中。未启用未验收生产profile，未提交、推送或发布。

## 默认关闭门禁、验证包与Linux固定配方

`011b0b79` 将相同固定Core配方在真实Linux aarch64/glibc2.36上执行。工具镜像从原SDK镜像
`35dad7f4...` 派生，仅复制官方Node24；官方镜像固定digest
`c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`，实际Node v24.22.2。
实际fixture镜像ID `461aea5b...`，原Debian主程序1ebc...未变。固定patch零fuzz应用、三C摘要
及GNU89构建实际完成，得到相同Core f1c104...，新适配器SHA
`7949f540184c42bd8a5b9e655353442a2f47f15f392b326b0dabcbad9836d1a4`，许可证随清单携带。
远端加载已使用结构化Core路径、本地绑定校验及SFTP回读摘要，按原顺序读取用户env，保留
早期用户Core/widget。实际profile只在绑定真实Core后产生unicodeVersion11。
`scoped-ssh-runs/12594afe` / `production-ssh-zle/82bdceeb` 八完成操作、真实Tab语义和第九
未提交EOF通过，已保存实际verified-display-binding，进程组143/ESRCH、普通用户恢复及早期
Core拒绝保持；镜像SHA `895a13244c809837c0e8bcfba089822df95691d5b6f28478bf74b6faa72edd5d`。
完整1946源/资源核对至退出，临时凭据删除、账户锁定均通过。默认0普通PTY对照
`scoped-linux-baseline/2b330957` 两场通过；本轮自有容器b704e3cd已停止并保留，未影响其他
既有P3容器。不是Linux四宽度或新宽字符gap Core的验收。

准入改为代码消费的 `protocol/agent/runtime/native-editor-admission.json`，生产profiles为空。
默认preparer不构建或收集未准入ZLE/PS产物；后端read_catalogue即使遇到源码/摘要都匹配的
缓存清单，也在artifact读取/复制前拒绝未准入profile。Bash既有路径不经过该编辑器准入。
受控模式需显式validation-editor目标、完整冻结源码与匹配的只读index/源清单摘要，输出位于
独立 `.native-input-p3/validation-resources/<uuid>`，标明validationOnly；后端还需显式进程环境
选择该Root，普通资源位置、stdout/OSC、前端ready和清单自报不能开启该模式。
preparer先写新的暂存目录，所有检查及源码打包完成才rename切换，旧输出移入独立备份；
失败暂存和旧产物保留，不部分覆盖已发布的资源树。

`603b36da` / `resource-admission/284838e4` 实际CLI验证：默认无已准入编辑器的目标输出为空，
P3编辑器目录不进入正常资源；真实旧Bash源摘要失败时前一正常输出逐文件不变；显式Mac/Linux
验证包成功，且未改变正常输出。`scoped-runs/60bfd1cf` 实际匹配清单及prepare在没有验证选择时
均返回PROFILE_NOT_ACCEPTED，镜像SHA
`d0c4fb8f3907cd5e68e092569317692d36aeb245425eadc519bcbe724cdf8449`。
显式选择后 `217529c2` 真实Broker/Session DTO通过，不制造操作或提交意图。

`8a6d3472` 将显式验证Root接入生产artifact resource选择入口；没有该模式时原Bash资源路径
保持。验证包自身marker只读核对，不由测试重写为已准入。`resource-admission/e43d119b` 再次
通过默认关闭、失败保留和双目标验证包。`scoped-runs/583ab366` / `broker-display-binding/6674f647`
实际从验证输出e747a156启动系统/bin/zsh，actual-resource-root.txt记录该包路径，真实私有
Capabilities、snapshot/local wait和Session DTO一致，实际PID/组63384均ESRCH；镜像SHA
`ceca5e653932108568c8c7f5d25431f04fb14ca162a252c227f257b13ffeac33`，完整1948源/资源至退出
核对。属于资源选择与Broker组件，仍不冒充Tauri窗口/registry运行时或完整产品包验收。

上述资源门禁、验证Root选择、清单路径保护与事务式preparer已在核对owner未被其他工作修改后
同步到实际仓库源码；未同步Core/provider新行为或更改普通Shell/配置/执行审批。
owner实际 `prepare-native-input-resources --no-build` 成功，普通generated仅含六个原已验收
Mac/Linux Bash profile、catalogue、sources及manifest，没有editors-*、ZLE或PS可执行profile。
原输出保留在 `.native-input-p2/resource-build/previous-117940f5-29e5-4adf-83ed-92a7d16b7757`。
owner `cargo check --locked --lib` 通过。该结果证明默认资源准入门禁，未把P3纳入已验收产品。
最新续接记录为 `.native-input-p3/p3-checkpoint-20261102-070558.json`，保留实际资源包、
默认关闭/显式验证、Linux固定配方、owner代码门禁及未完成事项的独立边界。

协调会话在9e发现真实主题边界失败：walters四宽、adam1窄宽的完整复制含源外wide-wrap空格。
旧9e/全部FAIL保留，简单prompt通过不外推这些主题。后续独立204受控验证及固定配方更新
见下；生产支持矩阵仍未开放。

## 204宽字符间隙固定配方及Session资源续接

协调的完整原件索引为 `.native-input-p3/root-wide-gap-evidence.md`。204仅在正预算、宽字
放不下当前行时使用原生已有WEOF非输出填充，使宽字触发真实终端自动换行间隙；默认0保留
旧分支。已核对源差异与producer，未在前端删除空格或覆盖公共API。协调已提供walters、
adam1各四宽十三操作/七resize/全文copy+search/provider恢复、十四EOF、普通默认0原库对照、
父Shell语义及首完整帧光标回放；额外真实源空格场次保留全部61个源空格。均为明确组件范围，
不声明所有插件、App或持续闪烁通过，也不重复这些提示符/8192上界补验。

新完整修订 `c1dea856` 使用固定patch
`96807111913f9e4f48b2e13de262c5541d3a59b1053f8036b0e048bd6280d8c3`，refresh源摘要
`0e7cc033af79e0ad11b3f74cb569975a84073c9b48b81e9fc16a3be892d9a259`，其余两C不变。
重新从官方9b8d归档解压、零fuzz应用固定补丁并实际GNU89构建：Mac producer
`pinned-core/f3612ac6` 得到相同Core
`204b5d23a4ac312283650b1d20a57f380557206a0928a6d9b37347d477ac0e84`；真实Linux producer
`pinned-core/13d3fc20` 得到新Core
`511c605b17d91091bdd4f5e34f05874fcf4a1ecdf42a06a78e86197661a42329`。
两个实际主程序摘要abc565.../1ebc9b...均保持，许可证随产物记录。

`2421a095` 是后续资源/Session修订，完整1948源：只把Linux绑定指纹改为上述实测511，
Mac严格204；SourceRoot只接受该目标实际摘要，未扩大生产准入。Mac适配器实际重建为
`5aafadb38b9ddfdb09c94459e6c5dc044b7db6f84080307de881f906aa5323d7`。
Linux产物明确复用c1dea实际构建，逐项验证原native compile输入和artifact完全一致，不冒充
新目标构建。

首轮 `wide-gap-ssh.log` 的真实SSH用例通过且凭据清理完成，但外层资源全清单不变检查发现
并行Mac构建更新了另一目标catalogue，整轮FAIL保留，未拿内部通过覆盖外层失败。
停止并行资源变更后，新建全新受控SSH对端，`scoped-ssh-runs/51303bcf` /
`production-ssh-zle/7dbc766b` 完整通过：八操作、真实Tab语义、第九未提交EOF、早期Core/
用户widget保护、143/ESRCH、普通恢复、typed11与全部资源至退出保持；临时凭据删除、账户
锁定均确认。实际镜像SHA
`91e3188b04cf4ba7e973986588da5cc5a4af31e76ec0ecc96ffed55e573c19f2`。
`scoped-linux-baseline/58103fc4` 的真实stock/511默认0普通PTY两场通过；不当作Linux四宽显示。

`resource-admission/df968ed5` 的实际CLI默认关闭/旧失败保留/显式双目标验证包全部通过，包
位于 `validation-resources/b9dc52e2`。`scoped-runs/64032b22` /
`broker-display-binding/5f077bff` 真正从该包启动/bin/zsh和204，真实私有Capabilities经
Broker校验、snapshot/wait/Session DTO一致，无操作或提交意图，实际PID/组18663均ESRCH；
源/镜像/资源至退出核对。仍是组件和生产资源入口验证，不冒充实际Tauri窗口/registry运行。
两个本轮自有SSH容器124347cb、5fe11104均已停止并保留；其他旧P3容器未动。

确认上述固定双目标构建与受控加载后，owner只同步新固定pin/patch，pin SHA
`2ad8c65c691610ba813b6e6cd59dfdeb9beb0cb59dd54c02da395db9e01c3013`。
旧20cd/9e/f1保留在全部旧冻结副本和证据中；owner准入仍为空、Core/provider/registry新行为
未开启。owner cargo check --locked --lib及diff检查通过，未提交或发布。协调的恰8192字节
上界测试仍独立进行，本会话未降低上限、改变5000ms预算或延长动画。
最新续接记录：`.native-input-p3/p3-checkpoint-20261102-071924.json`。后续仍须区分验证包
组件、Linux实际显示和真正App/registry窗口，不能由本节阳性开放生产profile。

## Linux四宽度实时显示

`9196bbc2` 在已验证511/当前资源源码上增加真实SSH输入中几何检查：初始PTY为真实
32/40/100/180×30，持续读取真实PTY原字节，公共cell观察到完整ASCII前缀跨实际软行后，
另发真实Query并断言phase=typing、mayHaveSubmitted=false，才请求七次实际SSH PTY resize。
原5000ms预算、生产1200ms动画、后台连续输出保持；没有替换坐标、暂停后台或复制接口。
`ssh-live/63131857` 四场原始FAIL保留：原生八完成操作、第九未提交EOF、全缓冲证明、七次
resize及provider恢复都通过，但把包含两个真实Tab的整条源码要求逐字复制/搜索，四场均false。
检查原始公共选择文本确认长Unicode赋值原样保留，Tab按实际列展开为空格；没有据此改写复制
结果或删掉Tab用例。

新完整修订 `8e9b327d` 仅把Tab移为独立第九操作，reducedMotion=true，长Unicode仍要求
整条原文逐字copy/search；第十场为未提交EOF。额外真实Tab InputConfirmed必须匹配两个Tab
的原源码摘要、UTF8长度、cursor和end，再核对变量执行语义。计数明确改为九完成加一EOF，
没有虚增旧轮次或改变生产功能/预算。

`ssh-live/ef1d16c4-99bc-4218-a5e5-96e4933df860` 四场真实实时Chromium全部通过：每场
九个settled、一个未提交EOF、先实际wrap与typing Query再七次resize、完整Unicode原文
copy/search、长文及Tab真实FullInputProof、实际Core映射、后台143与进程组ESRCH、普通用户
恢复及早期Core/widget保护均通过。owned实际provider11，销毁前实际provider6，公共API不改。
实际复制镜像SHA `248363a1ca0a210d4eb279fbd3a5012fb7b87cdf5cc0156a1c1afc48d5cf6d6d`，
完整1948源、镜像、所有资源与正式5aabb依赖至退出核对；实际显示使用明确候选8ee和官方
Unicode11，编译的display来自该冻结源码，不从owner旧文件推断。

`ssh-tab-audit/e0935237` 对这四场原始公共selection与真实Tab缓冲证明只读核对，Python
标准expandtabs(8)按实际8列P3-SSH提示符计算的合法文本均实际存在，四项通过；没有归一化
产品复制接口或生成显示文字。该补审不计新增原生执行。
四个全新独占SSH对端均在各自场次后清理：系统钥匙串临时密码删除、账户锁定、容器停止
并保留；原两台既有P3容器未动。没有真实模型请求、Tauri窗口、WebKit/WebGL或完整平台
矩阵通过声明，生产profiles仍为空。

最新续接记录 `.native-input-p3/p3-checkpoint-20261102-073725.json`。8192字节边界仍由协调
会话诊断实际本地控制通道，不能因本节短输入通过而外推上界或调整原限制。

## Owner 集成与正式依赖复建（2026-11-02）

Core/ZLE、local/remote/coordinator、Broker/Session binding、类型化DTO及registry/provider
实现已同步到owner；普通默认provider仍为6，productionProfiles仍为空。验证包通过显式
冻结源码及资源门禁选入，普通资源入口不自动携带P3编辑器。

EL0软换行补丁已通过固定上游源码和正式构建工具重建并记录，正式pnpm补丁为
`f7033223c167901eecd6f7f80c29ef48d0ae6ceb54e65d498d1e03f67d10ead9`，UMD为
`8ee22355a99acc05e630d93072c7201b48423fe8524b95f45da0739ee7d03921`，ESM为
`4f52a69529fe38b20533ac8097944d38f8dd73dc630aa562a43befd64d2076e7`。
记录见 `.native-input-p0/xterm-package-builds/2026-11-01T23-47-55.528Z/manifest.json`。
旧5aabb冻结证据保持原样，不追溯改写其依赖身份。

上述Linux四场真实捕获在Chromium/WebKit×DOM/WebGL×四宽度重放16/16通过：
`.native-input-p3/ssh-renderers/9e31c5a3-4104-4b28-aadf-da0b97d3f0be/result.json`。
协调独立复查同一矩阵也16/16通过（`root-linux-scoped-renderers/8d3f5584`）。
两轮都是已有真实PTY、几何和FullInputProof的只读重放，不增加原生执行数或窗口验收。
正式依赖对既有真实Bash捕获的复制与普通编辑重放也通过：
`root-formal-copy-regression/b6571e33`，copy736 lanes（344项适用candidate lane）、ordinary-stock24
lanes（12项直接stock对照），输入/源码/资源前后摘要稳定。均不证明滚屏或闪烁。

当前owner源码已实际重建Mac/Linux各三种既有Bash资源及双目标ZLE模块；Mac模块
`2561dd19f2813449ee9d053d1fd0c7de26be822d15e5de4aa26f4a0bfe558f03`，Linux模块
`580c30ce5ada45c2b859eb1476b6d55b97662f2001eadc21c9bc9dc24378db88`。
Core仍为已核对的Mac204b/Linux511c。普通资源准备通过且仅含六个Bash配置；显式验证包
资源事务检查通过，旧Windows资源显式选择仍失败并保留原输出，不能写成Windows通过。

共享 `PreparedNativeBash::start` 使用实际GNU Bash5.3、生产监听和双向控制的回归通过：
完整冻结源码 `089d830d-5164-40b8-82c2-f1d32b5f755a`，1967文件，
`scoped-runs/e92ab885-5297-439c-ad75-173709d65504/result.json`，实际证据
`prepared-bash/98e36bfd-5074-40a9-85eb-147c8aba520d`。完成实际提交0、提交前清除草稿且
无执行效果、前台进程组53059受Ctrl-C后130和ESRCH、父Shell变量保留及后续提交0。
未要求Bash发出ZLE专有EditorReady；测试使用生产Readline服务唤醒；取消断言接受真实
InputProgress或真实FullInputConfirmed后、最终接受键前。前三轮测试前提失败完整保留于
冻结c5e46a16/ee4b0958/a08ade17，不宣称中途动画取消已单独覆盖。

owner TypeScript/Vite构建、Rust lib检查与测试编译通过；terminal_command域13通过、7显式
原生fixture忽略；真实显示捕获52项断言通过。完整前端套件321文件通过、1失败、2跳过，
2915测试通过、1失败、8跳过。唯一失败为未修改AI展开样式测试
`ai-turn-process-phase4.test.tsx:101`；在独立旧冻结源码与旧依赖也重现同样失败。
Rust全仓格式检查仍存在未修改AI/旧broker/Windows示例等既有差异，不将其视为本轮通过。
本轮涉及的Rust模块独立格式检查通过，77个include文件检查和diff空白检查通过。

Mac已手动解锁；实际submit-fault窗口仍待完成。冻结29fbd57d先在review参数前置校验失败；
新443f091d修正review适用范围后，两轮在前端源码扫描停滞，均无App/model命令执行。
采样含Tailwind worker的 `std::fs::read→open`，fixture预先创建的FIFO为可疑阻塞点。
被信号结束的原轮result记录exitCode=null，不能用外层退出0宣称通过。
30359ff0将证据目录移出隔离根的方案被原有校验拒绝，完整保留FAIL；owner保留原路径门禁，
改为静态构建后、App启动前创建同一真实FIFO，并记录子进程code和signal，信号退出计失败。
冻结c44f1ae2/4cb267cd已实际通过前端构建并启动App，证明FIFO时机修正有效；该轮在审批前
测试断言失败：真实命令原样、timeoutMs=60000，但canonical参数省略background字段。
生产 `native_adapter.rs` 使用 `background.then_some(true)`，后台false会省略；
`TerminalExecuteArgumentsNative` 对缺省background定义为false。因此新断言按既有协议
接受缺省或false，仍拒绝true/null等其他值，命令与超时保持原值校验，不改审批参数。
旧FAIL保留，没有重放旧调用。0091b557/a3538879实际提交后暴露生产遗漏：停止超时只设
recovery/pending，阶段仍CancelRequested。已在同一Broker锁内对绑定native操作增加
StopUnconfirmed转换：已可能提交→Uncertain，未提交→RecoveryRequired，不生成ended或
清除证明，不结算持久意图。迟到真实Started可更新started且保持Uncertain、重复幂等；
可信Settled仍可更新结束事实。领域14测试通过、1显式忽略，包含546状态事件组合；既有
恢复准入5测试通过。测试仅捕获精确的停止未确认IPC错误，其他异常继续失败。

29e06e61/0e37dd30实际达到Uncertain并通过前后端禁写、原durable fence、释放FIFO后
目标只启动一次、INT/HUP掩码和局部trap不泄漏、显式关闭后的真实PID/组ESRCH。其后
测试错误要求closed snapshot不存在；Broker实际保留open=false关闭审计记录，已按现有
snapshot/close协议校正为必须open=false，仍要求旧ready被拒绝。该轮FAIL原样保留。
204e15d7/6aea76c3实际恢复行为报告全部通过：约2055ms后返回精确恢复错误、Uncertain与
禁写、一个不自动重放的旧意图、目标85042只进入一次且信号状态正常、关闭后PID/组ESRCH、
旧ready拒绝、新native-inline终端真实执行用户命令，旧意图仍未结算。但人工目视核验未完成，
完整入口最终超时exit1，整轮保留FAIL，不能写作原生窗口通过。

最新完整冻结58f6f938新增真实迟到Started检查：释放门后必须直接查询同一Broker操作的
startObserved且phase=uncertain、提交/持久意图/恢复标志保留。人工窗口等待改为180秒并写
请求开始记录；输入/动画/提交/停止预算不变，完整入口仍600秒。协调会话独占GUI/1432，
另从当前owner创建全新0ccbb220副本进行原生窗口验收，本会话不并发启动App。
0ccbb220/9691022b完整入口FAIL，严格迟到Started检查发现：不明等待结束后执行器已退登记、
activeCommand消失且lease回user，真实迟到回执被忽略。旧故障完整保留，未放宽断言。

owner现已通过Broker内部只读native_observation_pending判断，未结束的native不明操作只
结束这次等待，保留原coordinator、捕获围栏、活动操作和revoking lease；非显式关闭的
finish_registration也不能将其退登记。TerminalClosed仍完整清理原登记；没有把未知意图
写成settled。初稿访问私有lock的编译FAIL保留，已改由Broker内部方法读取权威事实。
完整冻结15a3a03c的实际App复验通过，严格late Started断言与人工review门保留，详见下节。
更新后owner TypeScript/Vite构建、领域14/忽略1、恢复准入5及执行器相关27测试均通过。
同生产修订的本地ZLE正常十三项已在204e15d7的scoped-runs/4bc78a81通过；最新58f6f938
十四项真实EOF在scoped-runs/430a8b61通过；binding e718351f、默认关闭准入1541f837通过。
同58源码的normal与Bash再次通过；guards实际11场全部通过，但旧runner仍预期10使外层
失败，保留FAIL并按源码明确列出的11场修正计数，未删除用例或修改断言。后续paths未执行。
上述源码、实际测试镜像、Core与全部资源均核对至退出，不代替新增退登记修正后的App验收。
新修改的state/tests格式差异只位于既有128/144/195/202与41/58行附近；新增停止转换和
回归段未出现格式差异，未扩散格式化既有代码。
本轮自有SDK容器shellspan-p3-owner-bash-build-20261102已停止并保留。

## 真实App不明状态与显式恢复

完整冻结15a3a03c-58c7-410b-9072-769b4bb27a0f，1967文件，实际轮次
`.native-input-p2/app-p3-zsh/98bae311-b180-4165-9cd6-d2276d426302/result.json` exit0。
真实MiniMax-M3.1-Flash仅一次工具调用，经原样审批、完整原生证明、FULL持久意图与单次
接受键到用户preexec门；停止约2008ms后真实返回精确恢复错误，同一操作Uncertain且禁写。
前后端拒绝哨兵且输入序号不变；SQLite旧意图恰1、noAutoReplay，未知结果未被结算。

释放原门后真实目标只启动1次，INT/HUP掩码及局部trap未泄漏；同一Broker操作随后确实
记录executionEvidence=startObserved而保持phase=uncertain、mayHaveSubmitted、durable及
nativeRecoveryRequired，lease仍revoking。显式关闭后实际目标PID/组消失；旧代次open=false，
旧ready被拒绝；全新native-inline终端真实执行P3_RECOVERY_USER_OK，旧意图仍1且settled=0
直至App退出。源码、静态资产、原生资源及实际签名镜像均经退出校验。

协调会话CUA精确绑定PID87809与本轮存活bundle，AX URL/token匹配；点击真实Terminal
input聚焦（未输入命令）后，截图可见真实恢复输出和彩色父Shell提示符。观察标记
`native-p3-window-reviewed.json` 明确保留边界：初始截图和Raise均白屏，未接受初始未聚焦
绘制或无闪烁。该有界窗口通过不能回填为全部显示门槛通过。

白屏布局原因：base.css使空#root占满视口且body禁止滚动，测试将真实终端host追加在其后。
仅将该测试HTML空控制器root高度设0，并增加真实getBoundingClientRect视口断言；不改
1100×650 host、业务UI、renderer或任何输入/停止预算。新完整冻结6afe1d09保留该测试修正，
15a旧证据不改。只读布局渲染回归使用真实HTML、TS编译器提取的原host样式及实际构建CSS：
`.native-input-p3/cancel-layout/96a325be-c876-4248-94e1-d051bc18bb8e/result.json`，
Chromium/WebKit×1440×900及1200×760，旧HTML在视口外/新HTML在顶部共8项通过。
仅验证页面布局，不运行或替代Tauri、模型、终端API，不增加原生执行或无闪烁声明。
相同生产修订15a的normal十三操作、guards十一场、paths及共享PreparedBash真实回归均通过。

Windows固定SSH仍未恢复。尚未完成稳定滚屏/历史/闪烁、其他平台实际Session/registry窗口与
最终同版本平台/语义/ABI矩阵。P3未完成，P4未开始；未提交、推送或发布。

## ZLE append API 与实时历史观察

正式接口为 `shellspan.zle-native-append/1`：特殊整数参数 `ZLE_NATIVE_APPEND` 仅取 0/1，
默认 0。正向准入只接受匹配的实际 Core 和适配器；前端在首个 PTY 字节前读取经过校验的
`unicodeVersion=11`、`ownedReflowCursorLine=true`。源码、构建和生命周期约定见
[原生 ZLE append API](../../protocol/agent/runtime/native-zle-append-v1.md)。

标准 recipe 产物为 Mac Core `cc7f4263d1650d51ca82aead721c11409938f4808f967d4bf3c6709036533b84`、
Linux Core `c9e451bd49ad6481872af4a0b069719abc5083e7c2a03c8973b2d5e718186404`；pin 摘要
`6d406283b048822447196b422bd9ed1587f8c4a7efe43b184a482189aea720e9`，patch 摘要
`4213d322dd24ce45f0d74eddd86f0f39018b88fa7bf92997c83c765dc6ff28af`。两目标实际模块分别为
`bfa8cef36524321d9716381ae797a51649b39a8f7d6be52b8956b1d0708ed2ba`、
`b1bcc244a17b2c91cd6d0c2c219300372084620b42f251da7269ca3b963b8e94`。
这些 Core 没有加入公开生产 profile；不能据此替换用户 Shell 或声称默认启用。

完整冻结 `bf5f0eb2` 的十三项真实操作 `ccf071dd`、实际 Broker/Session 绑定 `c165a199`、
十四项真实 EOF `533caf34` 均通过。实际字符捕获 `e1d14d28` 的 literal LF/Tab/CR 普通/原生
显示与复制 12/12 通过；Tab 的真实填充空格与普通路径空 cell 不作原始 cell 相等要求。
首轮 `0db64e6c` 因适配器仍查旧 Core 导出变量被严格校验拒绝，FAIL 保留，未放宽摘要。

Mac 完整冻结 `6b844f22` 在当前正式 xterm patch `839044e6` / UMD `4b83bd64` 上运行
两种真实提示符、四种初始宽度与纯输入/后台输出两种场景，共 16 场、208 个实际原生操作，
每场进程退出 0。纯输入在真实未提交窗口检查完整源、搜索及光标；后台输出检查真实
合并流与同流固定宽度参考、全部完整后台记录，不将被后台输出自然打断的源码要求为连续。
两观察器同时消费实际 PTY，历史观察器使用真实 wheel 并选中旧输出；547 个选择后渲染帧
中选区及 60 行旧输出均保留，但 `adam1/input/32` 有 9 帧视口跳底，因此**历史视口门槛未通过**。
证据汇总 `.native-input-p3/native-api-mac-live-summary.json` 明确 `viewportPassed=false`；
没有将进程退出 0 冒充逐帧显示通过。实际渲染时序记录的是解码完成下界和已提供字节上界，
不声明精确 parser offset。范围只含 Chromium 默认渲染器，不能外推原生 App 或全部无闪烁。

Linux 完整冻结 `1cbe5d80` 使用同一 API 和正式 xterm 包，通过真实生产 SSH 在四种宽度下
分别运行纯输入/后台输出，共 8 场，实际每场 9 次完成操作和 1 次未提交 EOF。汇总
`.native-input-p3/native-api-linux-live-summary.json` 记录 241 个选择后渲染帧，未出现选区变化、
历史丢失或跳底；各场临时凭据删除、测试账号锁定、清理错误为空，容器停止并保留。
具体 LIVE 轮次为 `a3516780`、`ee572a35`、`72b970e6`、`ed7184d5`，均位于该冻结源的
`.native-input-p3/history-live/`。这仍是生产 SSH 组件及浏览器观察，不替代 App/registry/模型验收。

Mac 视口失败已导出为 11462 字节的真实 PTY 回归 fixture，摘要
`dca8663e56f0c29cb193a6486df7221f11e5c76d3cb74ca03f37f83b183245b0`。
正式旧包可稳定重现 32→180 时顶部从 `P3_HISTORY_37` 变成 `P3_HISTORY_44` 且跳到底部；
修复限定在依赖 Buffer 的坐标映射，不搜索内容或恢复选区。该修复的最终限定结果如下。

### 视口修复最终限定结果

视口修复已按标准 recipe 正式采用：构建清单
`.native-input-p0/xterm-package-builds/2026-11-02T06-00-02.560Z/manifest.json`；pnpm patch
`dcabd41abe0c11f5843c5c54490fa5742b8bfa012016db15ba179f1f7cbc567f`，UMD
`48f368b5d73659129b6c9e607377f92ea6258e0b6945166e419011d71846f0d4`，ESM
`37e0538c9553252190ee342eee11dad8426f2d2d94a463c91ea2bac612046840`。
独立候选及正式构建的全部源码、UMD/ESM/maps 摘要一致，安装包再独立核验一致；没有手改
`node_modules`。正式回归 `native-selection/61ee511d` 覆盖 56 项选区、8 项历史停留/底部跟随，
四种浏览器/渲染器组合全部通过；64 项显示断言及 TypeScript/Vite 构建通过。同字节独立候选
在真实 Bash PTY 重放中通过 736 lanes / 344 applicable candidates，以及直接 stock 普通路径
24 lanes / 12 applicable candidates；这些不是新的 Shell 执行。

新完整冻结 `7ec4c0a7` 的 Mac 纯输入 8 场为 `912d9957`，Linux SSH 的纯输入/后台输出
各 4 场为 `2bcca791` / `7397e63a`。Mac 后台输出首轮 `4f8d21d0` 有 5 场通过，随后一场
因测试假设一次即时 poll 必须得到 settled 而失败：真实 stopRequested 后的即时查询仍是
running，这不等于停止失败。仅测试在原计划的最终查询前、原有 8 秒观察窗口内只读等待
真实进程组 ESRCH；生产 helper、13 项命令、接受键及输入/动画/resize 预算不变。`fb006eaa`
的 `49905338` 补过 40/100 列；180 列对单次 EPERM 作出过早失败。最终 `0791578f` 的
`e9230d4c` 在同一窗口内持续观察，严格等到 ESRCH，再检查真实 settled/finished 143，通过。
没有将 EPERM 当成成功，没有追加执行或重放查询，两轮 FAIL 及其日志保持原样。

三份完整冻结源只有 `src-tauri/src/terminal_command/zle_tests.rs` 不同，其余 1975 项源码
逐项摘要相同，生产 Core、模块和正式 xterm 相同。最终矩阵汇总
`.native-input-p3/viewport-live-matrix-summary.json` 明确记录上述来源边界、24 个唯一场景、
775 个选择后实际渲染帧及两项保留的失败轮次。所有计入成功场景的选区、60 行历史、历史
视口和未提交观察满足契约；Linux 临时引用删除、账号锁定、测试容器停止并保留。
此前失败的 `adam1/input/32` 新截图实际可见顶部及选中项均为 `P3_HISTORY_37`。
范围仍为 Chromium DOM 的真实组件与浏览器观察；其他 renderer 只有就近回归覆盖，
不能据此宣布全平台原生 App、初始绘制或持续无闪烁通过。P3 未完成，P4 未开始。

GNU Bash/Readline 的新公开显示列 ABI、Mac 三版本真实 NIP/显示及 Linux 后续状态见
[GNU 独立审计](agent-terminal-input-gnu-display-abi-audit.md)。GNU 生成资源由协调会话独立
构建验收；当前旧 owner GNU 资源已失效，不用于新的 App 包。以上 ZLE 冻结源有各自完整
源与资源边界，不将其冒充 GNU 最新实现或最终全平台矩阵。

## 当前 API 的原生 App 与 scratch 并发重开

完整冻结 `29c6ca1a` 同时具备正式 ZLE API1 Core、正式视口补丁及 Root 独立验证的 GNU kit。
本会话复用该完整源并使用独立数据目录，没有将旧 GNU 生成资源装入新 App。
no-model 启动轮次 `.native-input-p2/app-p3-zsh-startup/00a03950-b94b-48a9-94c2-2e1e3dd22ee7`
退出 0。真实 Broker 为 localPty/native-inline，绑定 Unicode11/owned reflow，promptReady、
nativeJobControl、user lease 均成立，无 active operation/recovery。CUA 精确绑定 PID16993、
本轮 bundle 和 token，首次采样前无点击/Raise/输入，截图可见真实彩色提示符及光标。
首个 Webview 诊断的 rendered 字段在 parser drain 前为空，不能用它证明可见；窗口事实以
该 CUA 采样为准。这不声明 frame0 或连续无闪烁。先前辅助入口把证据放错目录的 `1e705c90`
在 App 启动前被原有隔离门拒绝，完整 FAIL 保留，目录规则未放宽。

同 `29c6ca1a` 正常模型轮次 `app-p3-zsh/0f41d912` 退出 0：MiniMax-M3.1-Flash 实际七次
calls/results，17/17 leases release，requestApproval、父 scope、history、停止及 exit7 通过；
实际 renderer 的 native-inline、Unicode11/owned reflow 绑定及完整源/早期输出有独立证据。
初始化和执行的源码、静态资产及实际签名镜像均校验至退出。后续背压轮次 `ba26c7a7` 保持
FAIL：草稿内容、工作台与活动终端保持，但焦点变为 BODY；清理另报 scratch 所有权错误。
尚未证明这两项错误具有因果关系。

scratch 错误已独立复现：生产原子写在 records 目录建立 NamedTempFile，另一个 runtime
重开时会将尚未发布但 JSON 完整的临时文件读成 Record，因文件名不是 key.json 被拒绝。
最近的真实文件系统回归从实际 Workspace/Record 出发，生产 persist 与 ScratchStore::open
各并发运行 500 次，修复前 206 次报同样错误。只读写同一路径的旧 16,000 次探针未覆盖该
枚举窗口。修复将 Record 的待发布文件放入独立私有 pending 目录，再由 tempfile 原子
persist 到 records，并同步相关目录；读取端的 key/版本/路径/权限/symlink 校验未放宽。
相关测试 8 通过、1 个受控 SSH 专项显式忽略，包括并发重开、staging symlink 拒绝与既有
恢复/配额/回收站语义；Windows 实机尚未验证该修复。

新完整冻结 `b13af012` 有 1983 文件，只比 `29c6ca1a` 修改三项 SSH 测试入口、scratch 的
实现/存储/测试三文件以及 native-jobs 只读焦点失败诊断。测试显式选择真实 Zsh SSH peer，
生产 Shell 探测、哈希、审批和输入预算保持原约束。该源的 `app-p3-zsh/e8f484a2` 完整真实
SSH App 通过：sshPty/native-inline，Unicode11/owned reflow，七次 calls/results，17/17 leases，
完整源、早期输出、原历史、停止及 exit7；正常 Keychain API 删除临时引用并核验不存在，
受控 nativeZle 账号锁定，peer7877 容器停止并保留。源码、静态资产及实际签名镜像校验至
退出。本轮没有 scratch 所有权错误；Windows 仍需独立实机复验。

同 `b13af012` 的新本地背压 `bfb51cea` 完整入口退出 0。实际 admission 为 running、
fullInputConfirmed、submissionIntentDurable、outputPausedAcknowledged；privateSettledBeforePty
和 withheldToolResult 均成立，250ms、2702 字节后恢复，七次 calls/results、17/17 leases，
草稿与焦点断言本轮通过。旧 `29c6ca1a/ba26c7a7` 的焦点失败原因仍未认定，保留 FAIL，
不以本轮通过推断它由 scratch 导致或已自动修复。

同源可见前缀取消 `b5de27d5` 完整退出 0：实际可见前缀非空且 fullInputConfirmed=false，
受控执行效果文件不存在，实际 SQLite 提交意图总数为 0，清除确认及普通用户恢复通过。
交互 `3f3faff8` 完整退出 0：同一实际 PTY 的 REPL/TUI、fresh-task 凭据门禁、8 calls/results、
credentialInputBlocked 及 publicApisUnmodified 均成立。争用 `d4e42350` 完整退出 0，含真实
冲突、重试、接管、关闭和 5 个操作、5 calls/5 results；没有把 10 个 call/result 事件误计成
10 次调用。各轮源码、静态资产及实际签名镜像均核验至退出。

该源的实际 namespace guards `d764e787` 为 11 场，EOF `7fbe55e9` 为 14 场，随后实际
Broker/DTO 绑定、manifest 路径及默认关闭准入各 1 场均退出 0。综合只读核验记录为
`.native-input-p3/current-p3-app-summary.json`，独立重新核对了七个有明确源版本边界的 App
入口、源码和静态资产摘要、各轮结束时签名镜像校验、临时 SSH 凭据清理，以及五类边界结果。
App 退出后的 SIGTERM 143 是验收入口的受控退出，不与用户命令的 exit7 或作业停止状态混用。

2026-11-02 14:52（Asia/Shanghai）完成本轮后只读查询本地 Tailscale：Windows100.64.0.82
仍 Online=false，最后在线为当日 01:35。未发起新的 SSH 或凭据复制；旧微软签名匹配模块
运行一次 R 及临时凭据复制/清理授权保留，不能据此声称 PowerShell 5.1/7 最新 App 通过。
GUI/1432 已交回协调会话用于其 GNU 无模型签名 bundle smoke，本会话不再并行启动 App。
P3 未完成，P4 未开始；未提交、推送或发布。

### 旧焦点 FAIL 的只读对照与待复验项

后续对 `29c/ba26c7a7` 与 `b13/bfb51cea` 的完整源码和保留现场做了只读核查，记录为
`.native-input-p3/focus-loss-readonly-audit.md` / `.json`。两份生产 UI、终端焦点/控制、composer、
store/hook 源摘要相同；用 TypeScript AST 去掉测试新增的 documentFocused/editorConnected
两个只读诊断属性后，整份 native-jobs 测试相同，原断言及建立草稿的边界没有变化。
因此新通过不包含生产焦点修复证据。

旧轮次第二次 wait 已 completed（seq201），随后 request/context210、assistant/chunk211；
第三次 wait 到 seq223 才调用。快照 latestEvent211 是最后看到的 runtime 标记，不能当作
DOM 失焦原因或发生时刻。backend 日志显示对应私有租约在14:30:14已 Completed 释放；
快照 terminalOwned=false 不能还原前端是否有延后焦点动作。释放路径静态为
cleanup(active,false,true)，现有记录不支持直接认定“释放租约强制切回源终端”。

失败路径没有保存 focusout/window focus/visibility、原生窗口激活、编辑器连接/可编辑性变化、
checkView 触发来源和客户端单调时钟；其 catch 时 isConnected=true 不能排除瞬时脱离。
成功路径没有连续焦点记录且正常清理已删除 session journal。缺失事实不能事后补造，
scratch 清理错误也不作为该断言的归因。此问题与 Windows 未验收分别保持未完成。

未来仅在独立受控桌面或用户明确验收时段，才可另行授权全新原七调用 post-input-backpressure 实机场景：原命令、审批、
草稿/工作台/活动终端/焦点断言及预算不变，补被动 DOM/原生窗口焦点、编辑器生命周期和
lease/runtime 接收时间线，首次违例冻结并在 cleanup 前保存，不强制恢复焦点、不包装公共
焦点 API、不用伪造输入或延长期限；若只得到另一次通过仍不关闭旧 FAIL。具体最小传感项、
证据边界及按现场事实分流的后续修复范围已写入上述报告。本轮未启动 GUI、App 或模型。

### 被动诊断已实现，当前桌面执行已禁止

被动诊断已接入现有Zsh P3背压入口，完整冻结源`54323f40`有1986文件，尚未启动原生App或
模型。RAM为2048条/384KiB，首次违例独立保留，超限明确失败；只记安全焦点/窗口/DOM/
租约事实，role白名单、未知为other，无文本/输入值/字符/aria-label或公共焦点方法覆盖。
诊断通过同一验收token的一次性端点在清理前保存0600/wx私有文件，主结果绑定文件SHA，
原1MiB结果门保持。AST核验原100条断言、七调用原命令/审批、焦点谓词及全部等待/250ms
未变；严格类型检查和Chromium/WebKit真实无头观察器/HTTP/文件检查通过。后者不算Tauri
原生窗口或模型验收，完整静态结果在`.native-input-p3/focus-trace-ready.md/json`。

用户随后明确反馈测试反复抢走前台焦点，禁止再启动任何Mac GUI/原生App/模型验收；
本会话之后只做无GUI源码/静态工作，协调会话释放GUI也不再视为启动授权。现有show/
setFocus及部分launcher的visible/focus/alwaysOnTop分支仍需收口启动与窗口策略，初始化与
清理也不能例外；隐藏执行不能冒充前台焦点通过。冻结源和所有失败证据保留，不重放不明
提交。旧焦点FAIL与Windows实机缺口分别保持未完成，P3/P4不勾选。
