# P2 Bash 生产接入审计

更新：2026-11-01。**P2 在下述源码及平台范围内完成验收。** Bash 生产快照的
42 个必需组合与 3 个生命周期组合全部具有有效冻结证据；另完成真实 SSH 故障恢复、
交互凭据门禁、委派、争用及关闭验收。最后的 Zsh 私有 stty 兼容性修复单独验证，
不把此前 Bash 镜像记作修复后版本的全矩阵。完整入口曾实际失败，原结果保持 FAIL；
本结论来自原完整执行、独立补验和明确范围的后置回归，不宣称一次完整入口全绿。

未创建 commit、push、tag 或发布，未操作业务主机，保留并行 SFTP 与存储修改。
本会话不实施 P3/P4；两阶段仍属于已授权总目标，由后续会话继续。

## 源码与证据范围

以下路径相对于仓库根目录的 `.native-input-p2/`，该目录被忽略。制品、原始流、
实际签名镜像与各阶段摘要留在本机，不提交二进制或凭据。

| 标识 | 不可变源码目录 | 实际验收范围 |
| --- | --- | --- |
| Bash 生产快照 | `acceptance-source/815bf51a-262f-4b1a-afbd-93906f133d7b/ShellSpan` | 完整真实执行及补验后的 42/42 必需组合、3/3 生命周期；状态/冷恢复、目标端专项、浏览器、资源重建与打包、四项辅助应用验收 |
| 交互测试变体 | `acceptance-source/4f37bd17-76c7-42db-b440-8ddf00a35e50/ShellSpan` | 仅四个声明的测试/入口文件不同，其余生产源码逐字节等同 815；新任务凭据门禁真实通过 |
| Zsh helper 修复 | `acceptance-source/4c61dfe8-5095-4468-9cfd-c39e2b81b76a/ShellSpan` | 除上述四个测试文件，生产代码仅 `terminal_integration.rs` 的私有 Zsh stty helper 改变；两项真实 Zsh 压力测试、13 项实际 NIP 与 2 项检查点回归通过 |

每份 `source-snapshot.json` 记录基线 archive、worktree patch、untracked source、
实际源码摘要及共享改动审查。4c61 的精确生产差异另存上级目录 `zsh-helper.diff`，
**它不是 productionSourceIdentical=true 的测试变体**。该修复不改变生成的 Bash 脚本、
NIP 协议、用户命令、monitor、信号策略、工具参数、审批或隐私门禁。
持续变化的整个工作区不在这些冻结快照的验收声明内。

仅 815 的严格矩阵汇总为 `evidence-summary/eff93fac-662f-459c-a539-080c0c53e773/summary.json`：
`coveredCases=42`、`coveredLifecycleCases=3`、`frozenCoverageComplete=true`、`rejected=[]`。
附加 4f37 交互测试变体后的完整辅助汇总为
`evidence-summary/a5a5223e-ac4e-42e0-b82b-0f48789dd552/summary.json`：
上述覆盖不变，`auxiliaryComplete=true`，全部辅助场景具有冻结资产及实际镜像结束证明。
两个报告的源码范围明确，均没有混入其他历史生产版本填补矩阵。

## 实现与适用范围

正式模块位于 `src-tauri/native-input-adapter/` 与
`terminal_command/{artifacts,bash,local,remote,capture,coordinator}.rs`，接入实际
SessionManager、Agent terminal_execute、Broker/lease 和 SQLite 持久提交意图。
新客户端按已验证能力进入 `native-inline`；旧客户端与旧实例保持 legacy。
native/raw registry 不安装旧 source projection、typing 或 redraw。

验收 profile 仅为 GNU Bash 4.1/Readline 6.0、4.4/7.0、5.3/8.3.6，分别在
macOS arm64 本地 PTY 与受控 Linux aarch64/glibc 2.36 SSH 上验证。每个 profile
要求固定源码/制品摘要、默认编辑与信号 provider、UTF-8。保持真实 HOME、login、argv0
及系统/用户 profile/rc 顺序，不自动替换用户已绑定的 Shell。
Linux 目标端组件证据不等于 Linux 桌面验收。Zsh/PowerShell native、其他架构与平台不外推。

私有管理使用固定 bind-x 组件和空缓冲区证明，不接受管理行、不删除历史或改写历史配置。
完整源码确认和持久提交意图先于唯一提交键；不确定提交保留 no-replay 与恢复门禁。
组件只暂时抑制 Readline 空组件重绘，真实父/子/后台 stdout/stderr 与默认 INT 语义保留。
结果捕获独立等待真实 PTY 边界，缺失边界保留实际尾部并标记不完整或不确定。

存储沿用当前 `terminal-submissions`。冷启动发现旧 `terminal-submissions-v1` 目录时，
在创建新账本前返回 MIGRATION_REQUIRED；旧路径为符号链接或非目录时返回 INVALID。
不迁移、合并、重写或忽略旧提交记录，状态改变操作与重复调用检查均传播失败。
旧记录须明确人工恢复；不声明已实现自动迁移。真实 SQLite 冷恢复回归覆盖旧账本、
已结束操作和新旧账本并存，确认旧字节不变且不会创建替代空账本。

## 实际执行结果

本节 `815/`、`4f37/`、`4c61/` 分别指上表源码目录；日志位于对应源码的上级目录，
其他结果目录位于各自的 `.native-input-p2/`。

| 项目 | 结果及证据 |
| --- | --- |
| 完整 P2 入口 | 实际执行 `SHELLSPAN_P2_MODEL=MiniMax-M3 SHELLSPAN_P2_REASONING=off pnpm test:terminal-input:p2`。815 的 `validation/4440e397-1a80-48d6-bdca-8f9c3acc4b27/summary.json` 原结果 FAIL，矩阵执行完 45 项后因 3 项失败退出，专属 fixture 清理通过；后续步骤独立执行，未覆盖原结果 |
| GNU 资源与前置组件 | 上述完整入口实际重建 host/Linux 三版本，状态与冷恢复、Broker/executor/lease、旧交互、三项 native production 专项均通过 |
| 历史、启动、旧客户端、jobs | 815 的 `app-matrix/511b00e2-d2f5-4f54-b2db-fbbe9ec67295/summary.json` 原为 42 PASS/3 FAIL。新独立补验 `app-4.1/2026-11-01T03-07-46.521Z`、`app-4.4/2026-11-01T03-33-42.985Z`、`app-5.3/2026-11-01T03-36-00.549Z` 全部通过，最终严格汇总 42+3。jobs 保留实际七次工具调用、三次 poll、stop/143、最终 7、完整输入/持久意图与反压断言 |
| 几何、Unicode、输出恢复 | 815 原生三项专项通过；实际三版本、窄宽输入、中途 resize、超长 source、Tab/CR/引号/!、正常/INT/control EOF、父子及后台输出。Linux `linux-geometry/4a9473c4-6828-4f7b-b4fd-4cb8918da425` 含目标端信号与组件专项 |
| 浏览器实际渲染 | 815 Mac `browser/227148ba-8f0e-41e9-a47f-8319299f077c` 96 项、Linux `browser/901eab22-030e-412d-b741-23068e8420a6` 48 项通过；Chromium/WebKit、DOM/WebGL、真实流精确复制/搜索及公开 API。32/180 列代表截图已实际查看 |
| 源码包重建 | 815 `source-rebuild/322041d4-09fe-48ee-b390-3369a5cc2158` 通过，全新 packaged tree、GNU 源归档与 cargo vendor；不借用原 checkout 的编译结果 |
| release 资源路径 | 815 `release-smoke/dfb84c75-b756-4c25-a8f3-24631788e30c` 通过，实际 bundle/resource_dir、GNU/module 与真实 PTY，debugFallback=false；没有发布 |
| SSH 私有 EOF/恢复 | 815 `app-5.3/2026-11-01T03-07-16.881Z` 通过。实际 exec EOF、durable maySubmitted、恢复门禁、拒绝旧 transport、显式新代次，`effect-once.bin` 严格为 `ONCE\n`，无重放 |
| 交互、TUI、凭据 | 4f37 `app-5.3/2026-11-01T03-55-05.796Z` 通过。实际 NIP 初始执行、alternate buffer、text/Enter/y、同一专用交互 lease、原 Agent 真实读到 credentialLikePrompt；新 Agent 在同一 PTY 发出一个实际模型调用，由凭据门禁拒绝。真实静默 read 的输入长度严格为 0；物理 Enter/Ctrl-C 后 primary buffer、默认显示及公开 API 恢复 |
| 委派及子任务接管 | 815 `app-5.3/2026-11-01T03-05-27.813Z` 通过，直接保存初始 native profile/binding、同 transport/terminal/generation 的 full/durable 证明，真实子任务、父任务继续与接管 |
| 争用、接管及关闭 | 815 `app-5.3/2026-11-01T03-06-15.702Z` 与 `03-08-23.630Z` 通过，真实拒绝争用、确认接管、运行中关闭与幂等关闭 |
| 原 P1 兼容性入口 | 815 `current-p1-compatibility.log` 保持 FAIL：13 项实际 NIP、legacy Bash 等已通过，在 legacy Zsh 检查点失败。未执行的后段独立补验：`current-missing-checkpoint.log` 2 PASS、`current-p0-legacy-wire.log` 45/45、`current-p1-frontend-continuation.log` 134 PASS |
| Zsh 修复后回归 | 4c61 `zsh-private-stty-regression.log` 可见命令/后台任务/长输入 1 PASS，102.64s；`zsh-bracketed-stty-regression.log` 括号粘贴 1 PASS，105.16s；`native-protocol-after-zsh-helper-actual.log` 13 PASS/0 ignored，15.67s；`checkpoint-after-zsh-helper-resources.log` 2 PASS，26.83s |
| 前端与构建 | 815 完整入口相关 167 PASS/1 skip，`current-typescript-build.log` 的 TypeScript+Vite 通过；4c61 最终构建见 `final-build.log`。修改范围 rustfmt、77 个 include 文件检查、差异空白检查通过 |

## 失败保留与归因

首次完整入口 `validation/76694c15-cc28-4cb4-a8aa-151099d8565b` 在 GNU 下载时因 Python
证书链失败，未进入原生场景。后续只复用此前已按固定摘要验证的 GNU 归档与补丁作为
下载缓存，仍实际重新编译；未关闭 TLS 或修改系统证书。

815 完整矩阵的三个失败来自实际模型参数：4.1 local/history-empty 的 wait_process
字段被 schema 拒绝，4.4 local/jobs 与 5.3 SSH/jobs 的参数或源码不满足严格约束。
后续使用全新上下文独立补验，原失败不改，未归一化参数、降低审批或自动重放。

交互原入口的多个参数错误及 ephemeralInputUnavailable 原样保留，不能据此认定凭据门禁通过。
4f37 新增独立测试入口，在原 Agent 实际读到凭据屏幕后释放其 lease，使用不带旧屏幕历史的
新 Agent 发出新调用；仍走同一 PTY、原工具 schema、审批和凭据门禁。
调用按 session/turn/step/call 关联，屏幕瞬时内容不持久化，未改产品隐私或安全策略。

当前 815 的同名 Zsh 可见命令测试多次实际失败，原始 PTY 有
`zsh: suspended (tty output)`；阶段开始前源码的同名测试实际通过，不能声称此项已复现为
旧基线。4c61 沿用既有 Bash 的私有 stty 调用方式，用 command substitution 中的 exec
避免辅助进程争夺前台 tty；不忽略 SIGTTOU、不改变用户 job control、不延长 deadline。
修复后上述实际 Zsh 压力与协议/检查点回归通过。这是 legacy 兼容性修复，不是 P3 ZLE 迁移。

4c61 初次后置检查因没有复制真实 P1 producer 清单或未传入 Bash 环境而失败，记录保留。
随后一轮漏写 `--ignored`，结果为 0 PASS/13 ignored，明确不作为覆盖。
最终使用原已验证清单和实际制品、核对 source/artifact SHA，带
`-- --ignored --test-threads=1` 得到 13 项真实通过。

早期锁屏、已删除临时 bundle、源码/资产漂移和端口占用各保留各自失败证据。
用户解锁后已完成上述全新冻结验收，锁屏不再列为当前阻塞。没有绕过锁屏或修改 ready 门禁。
探索性 Uint8Array 极端分块的 ZWJ cell 差异仍不作为生产路径通过；生产增量 UTF-8 字符串
路径的精确 source、复制及搜索断言通过，未删除 ZWJ 或更换 provider。

本阶段不代表整个仓库 Quality Gate 全绿。此前全量前端中的两项大 patch HEAD 长度与
一项折叠 class 失败、全量 Rust 工具目录 request_user_action 等失败见 P0/P1 原审计；
本次相关范围通过不覆盖它们，也不宣称远端 release workflow 已执行。

## 清理与复验入口

完整入口自动清理 d896bfec fixture；补验 fixture 97d89584 与早期 fixture 87e1754d
均先核对 `shellspan.native-input-p2` 标签，再由原脚本清理。其他任务容器不动。
逐轮 SSH 凭据删除使用独立引用并验证不存在；最终元数据审计：owner 130 个数据库、
815 共 60 个、4f37 共 2 个，待清理独立引用均为 0。

完整入口为 `pnpm test:terminal-input:p2`，默认新建并清理本地 Docker SSH fixture；
`--components-only` 不能代替应用验收。GUI 运行必须跨源码目录串行执行，避免共享端口竞争。
`matrix.mjs --case <版本/传输/场景>` 仅创建所选的新独立上下文，不重试原操作。
`summarize.mjs --require-frozen --require-auxiliary` 严格核对源码、producer/catalogue/module/
relay、实际 peer/binding、同身份 full/durable 证明、静态资产和实际签名镜像直至退出。
原完整入口、失败矩阵及所有失败补验不会因汇总通过而被覆写。
