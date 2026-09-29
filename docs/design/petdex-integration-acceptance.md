# Petdex 联动验收记录

日期：2026-09-29，Asia/Shanghai。本轮阶段0–5已按分层验证策略完成；当前逐项结果、证据类型和限制见[最终审计](#阶段-5-最终审计)。部署联动延期。前面的阶段0–4及阶段5中间交接段是对应时点记录，“待验收”“空白窗口”等不代表最终状态；潜在令牌误发事件与处置保留为必要审计事实。

## 阶段 0 环境与证据（当时观察）

| 项目 | 本次结果 |
| --- | --- |
| ShellSpan HEAD | `a09a6cfcdf48a84d40010d04c6dd50f2865f8d46`，版本 2.1.2 |
| 初始工作区 | 仅 `?? docs/design/petdex-integration-implementation-plan.md`，原有用户计划保留 |
| 目录规则 | 读取根 AGENTS.md；仓库文件检索未发现子目录 AGENTS.md |
| 系统 | macOS 26.6.2，build 25G83 |
| 工具 | Node v24.21.0、pnpm 11.1.1、cargo 1.95.0、rustc 1.95.0 |
| 安装 | `/Applications/Petdex.app`；Info.plist 与 package-manifest.zon 均为 0.8.0；bundle ID `dev.petdex.desktop-native` |
| 二进制 SHA-256 | `878448e0e0a742608df3d9f7048796e7b362166a5a648d5c676c089dc0fa7522` |
| 运行进程 | `pgrep -fl '/Petdex.app/'` 无结果；不等同于全面证明所有同类服务均未运行 |
| 端口 | `lsof -nP -iTCP:7777 -sTCP:LISTEN` 显示 Python PID 712，监听 `*:7777`；`ps` 与 `lsof -p 712` 核实为 Python 3.14，而非已安装 Native Desktop 可执行文件 |
| 凭证元信息 | `ls -ld ~/.petdex/runtime/update-token`：文件存在，64 字节，0600，9 月 6 日修改；未读取或输出内容 |
| 本地源码 | Spotlight 与 Developer 目录检索未发现 Petdex 源码 checkout；安装包仅含原生二进制和资源 |

未安装、启动、停止或重启 Petdex，也未停止占用端口的进程。没有向 7777 发送 HTTP 请求或令牌。当前不能将残留令牌、端口监听或历史测试文件当作真实服务通过证据。

上游 GitHub API `git/trees/desktop-v0.8.0?recursive=1` 返回标识 `f2ea48aac6f89fbaeedd6a639faf4e208864ae5d`。通过固定标识的 raw URL 下载并阅读 `packages/petdex-desktop-native/src/hook_server.zig` 的完整路由、认证、时长解析和队列，以及 `main.zig` 的状态消费、停留和到期处理。下载内容只用于阅读，未执行上游代码。

- hook_server.zig SHA-256：`8dc82d501fe6e700987a9f266af96b7b2ee066bf09e282182b816509ee507150`。
- main.zig SHA-256：`d8f8030d214202d5532cc37e5e65a1ea2a7e9314b20f86c6d89c01fc1e4b6bf0`。
- 固定源码链接、核验结论和证据级别见 [协议记录](../../protocol/petdex/integration.md)。安装二进制与源码尚无构建一致性证明。

## 阶段 0 影响范围与现有测试

| 范围 | 后续可能涉及的文件 | 当前测试/核查 |
| --- | --- | --- |
| 通信、仲裁、发送 | `src-tauri/src/petdex.rs`、`petdex/{types,transport,arbiter,delivery}.rs` | `petdex/tests.rs` |
| command 注册与类型 | `src-tauri/src/lib.rs`、`src/lib/petdex/petdex.ts`、`src/lib/ipc/tauri.ts`、`src/types/` | `src/lib/petdex/__tests__/petdex.test.ts`；当前领域入口直接封装 invoke/listen，IPC 尚无 Petdex 适配 |
| SSH/SFTP 生命周期 | `src-tauri/src/session.rs`、`commands.rs` | 已定位 SSH 连接、关闭/失败及 SFTP 完成/取消出口；尚无启用时活动快照 |
| AI/部署生命周期 | `src-tauri/src/agent_runtime/`、`deployment/run_coordinator.rs` 及权威状态更新入口 | 留待阶段 3/4 确认，阶段 0 未声称已核实领域终态 |
| 偏好与设置 | `src/stores/appStore.ts`、`src/components/workbench/settings-panel.tsx`、`src/locales/{zh-CN,en-US}.ts` | `appStore.test.ts`、`settings-panel.test.tsx` |
| 反馈入口 | `src/lib/petdex/petdex-feedback.ts`、GitHub issue 表单 | `petdex-feedback.test.ts` |
| 旧独立协议探针 | `src-tauri/tests/petdex_contract_probe.rs` | 5 项已有 fixture 服务测试；不是实际 Petdex 协议证明 |

阶段 0 仅新增本验收文档、协议文档，并更新计划阶段 0 的证据与清单，不修改业务代码、UI 或测试，不新增 mock。

## 阶段 0 基线命令结果

| 命令 | 退出码/结果 | 证据边界 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex` | 0；18 passed，1 ignored，1117 filtered out；独立探针 5 项被过滤 | 已有纯状态和 fixture 回归；不是完整 Rust 测试或真实联调 |
| `cargo test --manifest-path src-tauri/Cargo.toml --test petdex_contract_probe` | 0；5 passed | 单独补跑被过滤探针；其中通信使用已有替代服务 |
| `pnpm exec vitest run src/lib/petdex/__tests__ src/stores/__tests__/appStore.test.ts src/components/workbench/__tests__/settings-panel.test.tsx` | 0；4 files，54 passed | 已有前端回归；出现 Vite 对未来 native configLoader 不支持 `__dirname` 的提示，无失败 |
| `pnpm check:rust:includes` | 0；47 include 文件检查通过 | 格式基线 |

忽略项为 `petdex::tests::controlled_macos_petdex_restart_recovers_without_adapter_restart`。该测试会主动启动、退出并重启 Petdex，与本次范围冲突，因此未设置 `SHELLSPAN_PETDEX_E2E=1`，未执行 `--ignored`。不能将 ignored 记为成功。

本次是文档基线，无业务变更，未执行完整 `pnpm test`、`pnpm build`、完整 cargo test 或 UI 渲染；后续跨前后端修改仍须按计划补齐，以上局部通过不替代这些检查。

## 阶段 0 当时的待验收矩阵与退出条件

| 必需项 | 当前证据 | 补验要求 |
| --- | --- | --- |
| 六种动作与 duration | 0.8.0 源码确认；未看实际动画 | 可用真实服务上依次验证动作、毫秒时长、250ms 最小停留和到期行为 |
| 认证失败与重启轮换 | 源码及既有 fixture 回归 | 真实受控重启，确认凭证变化和同一适配器恢复；不记录令牌值 |
| 只读健康与状态 | 源码存在 health/whoami/state；没有本机 HTTP 结果 | 验证真实端点；区分镜像状态与屏幕状态 |
| 来源隔离/释放/租约 | `/state` 结构与完整路由未提供 | 不依赖不存在的能力，不新增全局 idle 清理 |
| 关闭、退出后持续动作 | 客户端取消路径和服务端持久状态源码支持残留风险 | 真实运行后关闭联动、退出 ShellSpan 并观察；未解决前明确限制 |
| 多应用 | 共享队列、合并、30/s 限流由源码确认 | 两个真实客户端交错触发，记录显示顺序及恢复，不能以手写替代服务验收 |
| UI、AI、部署与并发等待 | 尚未实施 | 后续阶段按完整矩阵验证 |

退出结论：阶段 0 的契约、实现基线和限制已有可追溯证据，满足计划允许的“无可用真实环境时继续不依赖新增协议工作”的条件；真实协议行为核验及实际关闭/退出/多应用条目保持未勾选。下一阶段可以推进禁止重定向、异步凭证读取、诊断快照和既有协议内的可靠性工作。本会话不创建或实施下一阶段。

真实联调前必须先取得可用且身份明确的 Petdex 服务环境；当前端口占用的处置和应用启动不在本次执行范围。后续应记录版本、操作与非敏感视觉证据，HTTP 200 或测试通过均不能替代显示确认。

## 阶段 1 实现与环境复核

本阶段起始工作区已有计划、验收记录和 `protocol/petdex/` 三组未跟踪文档，均保留。仅修改 Petdex 通信、诊断、对应 IPC/类型、配置返回类型和设置页 Petdex 区域；没有新增来源、AI/部署联动、独立预览、来源释放或 idle 清理。命令名称不变，已核对 `src-tauri/src/lib.rs` 中三项注册。

实现结果：

- 诊断快照包含单调 `revision`、有限 `status/errorReason`、`targetAction` 和 Unix 毫秒 `lastSuccessAt`。成功时间只说明 HTTP 200；失败与关闭保留历史时间，关闭目标置空。
- 协调器锁内校验取消并提交状态；关闭后旧任务不能修改重新启用后的仲裁、唤醒标记或诊断。保留请求锁、事件合并、最短间隔、失败退避和令牌变化后的单次重试。
- `Policy::none()` 明确禁重定向，保留固定 loopback 地址、无代理及 250ms/750ms 超时；使用 Tokio 异步文件 API，令牌请求头标记 sensitive，不输出令牌或原始响应。
- 类型化 IPC 保留领域入口，Ajv 检查有限结构；前端读取、事件和操作结果共用修订号防倒退。读取失败可由有效快照恢复，订阅失败单独提示，手动配置/测试会重试订阅。一次性操作异常用 Toast，避免伪造后端诊断。
- 新增 3 项 Rust 生产状态测试、5 项前端生产状态/文案测试和 1 项默认忽略的真实服务测试。没有新增 mock 或替代 HTTP 服务；已有 mock/fixture 回归仅适配新返回契约并继续运行。

2026-09-29 10:19–10:23 CST 复核发现环境已变化：`lsof -nP -iTCP:7777 -sTCP:LISTEN` 同时显示 Python PID 712（`*:7777`）和 Petdex PID 18362（`127.0.0.1:7777`）。`lsof -a -p 18362 -d txt -Fn` 确认 executable 为 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`。无令牌 `curl --noproxy '*' --max-time 2 http://127.0.0.1:7777/whoami` 返回 `ok:true,pid:18362,parentPid:null,inProcess:true`；`curl --noproxy '*' --max-time 2 -sS http://127.0.0.1:7777/health` 返回 `ok:true,port:7777`。

真实测试再次调用 whoami，通过 `ps -p <pid> -o comm=` 核对安装路径并检查 health，随后才允许生产传输读取凭证并发送一次 `waving`、1200ms 的 POST。返回 `Applied`（内部名称，仅代表 HTTP 200）；诊断成功时间更新，关闭后为 `disabled`。不检查 `queued`，不宣称动画已显示。没有安装、启动、退出或重启 Petdex，没有停止 Python，也没有修改凭证或发送关闭清理请求。

## 阶段 1 验证命令与结果

| 命令 | 结果 | 证据范围 |
| --- | --- | --- |
| `pnpm test` | 0；283 files passed、1 skipped；2507 passed、2 skipped | 完整前端测试；执行后只追加读取/订阅恢复修复，以下局部测试和构建覆盖最终修改 |
| `pnpm exec vitest run src/lib/petdex/__tests__ src/stores/__tests__/appStore.test.ts src/components/workbench/__tests__/settings-panel.test.tsx` | 最终 0；5 files、59 passed | 包含新增修订号、有限字段、双语 label、读取/订阅恢复生产逻辑；现有 UI 和偏好回归 |
| `pnpm build` | 最终 0；TypeScript 与 Vite 生产构建通过 | 保留既有大分块及静态/动态导入警告，未改动无关构建配置 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0；库 1089 passed、50 ignored；独立探针 5 passed；main/doc 0 tests | 此时已包含 3 项新增状态测试，随后仅新增默认忽略的真实服务测试并格式化；无业务逻辑变更 |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex` | 最终 0；21 passed、2 ignored、1117 filtered out；独立探针 5 项过滤 | 最新代码的 Petdex 回归；默认忽略真实重启和已运行服务测试 |
| `SHELLSPAN_PETDEX_RUNNING_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml running_macos_petdex_accepts_production_transport -- --ignored --exact petdex::tests::running_macos_petdex_accepts_production_transport` | 0；1 passed | 精确执行新建的已运行服务测试；没有执行会启动/停止 Petdex 的旧测试 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 0 | 仅格式化本阶段修改的 Rust 文件 |
| `pnpm check:rust:includes` | 0；47 files | include 文件格式检查 |
| `pnpm check:ai-styles` | 0 | UI 边界检查 |
| `pnpm check:llm:catalog` | 0；55 models、4 negative fixtures | 目录协议回归 |
| `git diff --check` | 0 | 无空白错误 |

完整前端测试中的发布回归会输出临时测试项目 Cargo manifest 诊断，但测试整体退出码为 0；没有为此修改或跳过检查。Vitest 仍报告既有 Vite `__dirname` 提示。

## 阶段 1 实际渲染与限制

通过 `pnpm tauri:dev` 构建并启动本地 ShellSpan 开发版，在 `http://localhost:1420` 真实前端页面使用内置浏览器检查。未注入 Tauri mock、虚假诊断或业务数据。

- 1280×800 与 1024×700 视口中，中文和英文 Petdex 设置区的说明、状态、开关与按钮完整显示，没有重叠或裁剪；沿用原有行布局和共享 Badge/Button/Switch。
- 实测测试按钮图标与文字边界间距 4px。键盘从实验性集成页签进入正文后能聚焦联动开关，继续 Tab 跳过禁用的测试按钮并到达反馈按钮；未打开外部反馈。
- 浏览器缺少 Tauri IPC，实际显示的是读取失败/订阅不可用提示和禁用测试按钮；这验证真实失败 UI，不代表原生成功态、检测瞬态或所有错误类别的实际渲染。有限状态双语映射和恢复规则由生产状态测试覆盖。
- 开发版原生进程可运行，但本次 UI 自动化工具无法绑定未打包的 executable 或 `com.shellspan-dev`，因此没有把浏览器渲染当作完整 Tauri command/event 端到端验收。运行日志出现过 WebView 进程终止，未对无关启动行为作修改。
- 重定向关闭通过生产客户端配置和 reqwest 成熟策略保证；未为验证 3xx 新增替代服务，也未在真实 Petdex 上制造重定向。令牌轮换、不可读凭证和在途关闭继续有既有回归，真实凭证未被破坏或轮换。

阶段 1 退出结论：客户端诊断防倒退、取消代际隔离、禁重定向、异步凭证读取、有限错误语义及双语状态已实现，相关测试和构建通过；真实 Native Petdex 的有限通信检查通过。实际动画、所有故障状态的原生 UI、重启轮换、持续动作关闭残留和多应用显示仍未验收。

阶段 1 交接事项已由下述阶段 2 实现：活动快照与订阅顺序、独立预览、优先级及生命周期去重；取消锁和诊断修订号保持有效，没有新增来源 release/租约或全局 idle 清理。

## 阶段 2 实现与生命周期核查

起始状态保留阶段 0/1 的全部未提交文件。新增修改集中于 `petdex/{arbiter,types}.rs`、协调器、SSH/SFTP 权威工作线程出口、测试结果 IPC 和设置页 Petdex 测试按钮的结果 Toast；未修改页面布局、共享 UI、AI/部署运行或分类偏好。

| 场景 | 生产实现与证据 |
| --- | --- |
| 关闭期间开始、中途启用 | ActivityGuard 始终同步更新内存登记，启用与活动发布共用协调器锁；启用读取当前目标，不重建或清空活动 |
| SSH 正常/异常路径 | guard 覆盖整个 `run_ssh_session`，包括状态发布失败、known_hosts、连接/认证、channel/集成初始化与 session loop 的所有 `?` 返回；Connected 保留登记，正常退出中性结束，Err 失败，unwind 由 Drop 清理 |
| SSH 初始化期间取消 | 工作结束后检查真实 command receiver：排队 Close 或 Disconnected 为 Cancelled；不丢弃仍在运行的终端输入 |
| SFTP 成功/取消/部分失败 | 四个现有传输入口按一次真实调用登记，guard 移入 blocking worker；worker 返回前按原有领域结果结束活动，不按文件产生多个提示 |
| SFTP join error/等待方取消 | panic unwind 在 worker 内 Drop，guard 不依赖外部 await 后续通知；等待方消失时仍运行的 worker 保留活动，结束后自行清理 |
| 乱序、去重与内存 | 同运行 revision 防倒退；未知终态推进来源水位，后到 start 不复活；512 条终态历史淘汰后仍由来源水位拒绝旧运行；当前并发运行不受另一运行终态影响 |
| 过期和短暂故障 | 原始 occurred_at 决定到期，迟到过期终态只移除活动；退避恢复读取当前有效目标，不排队重放终态；已发请求与服务端队列无法撤回 |
| 测试动作 | 独立挥手预览，不清空成功/失败提示；失败与等待用户覆盖；返回 diagnostic/preview，发送时和返回时都识别覆盖，旧通信代际取消不会误报成功 |

有限来源数、运行计数器和活动表均不持久化，不包含凭证或业务内容；关闭期间没有 token/HTTP 路径。源生命周期为运行 ID 的分配与同步登记提供顺序保证，不能把该接口当成允许任意乱序 start 的事件总线。细节见 [协议](../../protocol/petdex/integration.md)。

新增 10 项 Rust 生产逻辑回归（8 项活动/仲裁、2 项领域取消分类），1 项前端生产契约/双语反馈回归，并扩展已有 UI 测试确认测试反馈不会因 rerender 重复。没有新增 mock、替代 HTTP 服务或测试专用业务分支；已有 mock/fixture 测试继续回归，其结果不替代真实联调。

## 阶段 2 验证结果

| 命令 | 结果与范围 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 31 passed、2 ignored；含活动仲裁、来源水位、预览、关闭/重开、并发 unwind、取消分类与现有通信回归 |
| `pnpm exec vitest run src/lib/petdex/__tests__ src/stores/__tests__/appStore.test.ts src/components/workbench/__tests__/settings-panel.test.tsx` | 5 files、60 passed；最终 Toast 去重断言也已通过 |
| `pnpm test` | 283 files passed、1 skipped；2510 passed、2 skipped；随后仅扩展已有 Toast 断言，以上局部测试覆盖最终前端测试修改 |
| `pnpm build` | TypeScript 与 Vite 生产构建通过；保留既有分块和静态/动态导入警告 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 最终 1099 passed、51 ignored；独立探针 5 passed，main/doc 0 tests；随后仅补强 Disabled 结果在快速重开下仍返回 disabled 的一行判断及对应断言，由最终 Petdex 局部测试覆盖 |
| `SHELLSPAN_PETDEX_RUNNING_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml running_macos_petdex_accepts_production_transport -- --ignored --exact petdex::tests::running_macos_petdex_accepts_production_transport` | 1 passed；已有真实 Native 服务接受生产客户端一次 waving 请求；未执行会启停 Petdex 的测试 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `pnpm check:rust:includes` | 47 include 文件通过 |
| `pnpm check:ai-styles`、`pnpm check:llm:catalog`、`git diff --check` | 通过；55 models、4 negative fixtures |

Rust 非测试构建提示 `Waiting` 和 Approval/Answer 尚未由业务构造，这是阶段 3 的预留接口；没有为消除该提示提前接入 AI。前端仍有既有 Vite configLoader 提示；发布测试临时项目的 Cargo 输出不影响测试退出码。完整测试日志位于本机 `/tmp/shellspan-stage2-frontend-tests.log` 和 `/tmp/shellspan-stage2-rust-final.log`，不是持久交付依赖。

## 阶段 2 真实环境与未验证项

2026-09-29 10:43–10:45 CST 再次核对：loopback whoami 返回 PID 18362、inProcess true，`lsof -a -p 18362 -d txt -Fn` 确认可执行文件为 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`。Python PID 712 仍监听 `*:7777`，未停止或修改。真实回归在读取令牌前再次验证 whoami/原生进程路径和 health；一次短暂挥手请求成功。未启动、安装、停止或重启 Petdex，没有发送关闭清理 idle。HTTP 200 不表示已入队或已显示。

通过 `pnpm dev` 和内置浏览器查看真实前端；1280×800 与 1024×700 的中文 Petdex 区域无重叠或裁剪，开关/禁用测试按钮保持原有布局。浏览器没有 Tauri IPC，因此实际状态为读取失败/订阅不可用，未注入诊断或业务数据。此检查不证明原生成功、覆盖、失败 Toast 的实际显示；新增四类预览结果的双语文本、契约及一次反馈由生产逻辑与已有 UI 回归验证。阶段 1 的双语/键盘/间距证据保留，未把它升级为本阶段新增反馈的完整原生验收。

仍待验证：真实 SSH/SFTP 与原生设置联动的完整并发流程、预览覆盖的原生 Toast、所有实际动画与持续时间、Petdex 重启轮换、ShellSpan 退出/重开、持续状态残留、多应用共享队列显示。没有用纯状态测试、浏览器缺少 IPC 的页面或已有 fixture 替代这些验收。

阶段 3 交接：复用 `ActivityGuard::start`/`transition` 和 `petdex::types::{ActivitySource, ActivityPhase, WaitReason}`；为 AI 增加明确来源，guard 必须属于实际运行或回合而非可复用会话。恢复运行注册和生命周期发布必须使用同样的同步顺序，保留总开关关闭时的纯内存跟踪和取消代际隔离。分类偏好、AI 与部署接入尚未实施。本阶段不创建后续会话、commit、tag 或推送。

## 阶段 3 实现与权威生命周期

保留阶段 0–2 全部未提交成果。新增 `agent_runtime/petdex.rs`，由 `AgentSessionStore` 持有活动；在 `append_payloads_locked` 持久化成功后、存储锁释放前观察生命周期事件。driver 开始覆盖 TurnStart 前的准备期，用独立代际结算；每个实际回合分配新的 ActivityGuard 运行 ID。已提交的历史终态不会结束新的准备期，旧 driver 结算不会移除新代际。`PetdexDriverLease` 仅对异常退出兜底，正常 Waiting 返回后主活动仍由存储持有。

审批与问题等待复用 `derive_recovery_checkpoint`；网络恢复等内部等待不冒充等待用户。对应回合 completed 生成成功，明确最终 Failed 生成失败，取消中性结束；不完整输出不自行推断最终失败，后续 Idle 中性清理。恢复仅登记仍待处理的审批/问题；普通中断运行需等实际 driver 恢复，历史结果不重放。Agent v5 外部协议未改。

SSH/SFTP/AI 分类默认 true/true/false，总开关默认 false，升级保留旧总开关。`petdex_set_enabled` 增加可选完整 categories 参数，注册名称不变；类型化 IPC、双语文本与偏好迁移同步。前端按后台最近确认值串行合并稀疏修改，失败不把未确认值写入偏好。总开关关闭仍可配置分类，但没有 token/HTTP 路径。分类关闭保留真实活动，只过滤展示，并取消旧通信代际。

成功/失败短提示已改为按来源保存。关闭 AI 只移除 AI 提示，其他来源与预览保留原截止时间；再次打开 AI 不补播历史结果。未接入部署，未修改其他设置页面或共享 UI。

## 阶段 3 新增回归及真实模型验证

新增 Rust 用例位于 `src-tauri/src/petdex/agent_activity_tests.rs`，其中 5 项使用真实 `AgentSessionStore` 的配置、会话创建、消息入队、`begin_turn_step`、提交、取消与重建入口，1 项直接验证生产分类仲裁。没有新增 mock、虚假 HTTP 服务、模型工厂或测试专用业务分支。

| 用例 | 可观察断言 |
| --- | --- |
| `agent_committed_turns_survive_driver_wait_and_isolate_concurrent_sessions` | AI 默认不展示，中途打开读当前活动；Waiting 结算保留活动；另一会话取消不清理本会话；同会话新回合不受旧会话终态影响；总开关关闭无结果提示和协调器 |
| `agent_success_is_published_once_and_reconstruction_does_not_replay_results` | 真实回合结束成功提示仅一次；后续 Session Completed 不延长 TTL；分类开关和存储重建不补播 |
| `new_driver_before_turn_start_does_not_inherit_a_historical_success_or_old_settlement` | 新准备期不继承历史成功；旧 driver 代际晚到不清理新运行；同会话连续回合及失败后 resume/retry 正常 |
| `committed_approval_survives_driver_release_and_store_reconstruction` | 网络等待仍 running；持久审批 waiting 经 driver 释放和存储重建保持；拒绝工具可继续回合而不误报最终失败；用户中断中性清理 |
| `incomplete_turn_is_not_a_final_failure_and_explicit_failure_is_reported_once` | 不完整回合不生成失败；真实最终 Failed 产生一次提示，重复终态不延长 TTL |
| `category_change_cancels_old_transport_but_preserves_other_sources_and_preview` | 分类变化取消旧代际；关闭 AI 不清掉 SSH 失败；分类关闭不清预览 |

`configured_model_question_and_answer_follow_real_driver_lifecycle` 为显式 opt-in 的忽略用例，已实际运行通过。读取开发数据库中的现有默认路由，源数据库只读，路由迁移和 Agent 会话写入独立临时目录；凭证经生产 `CredentialManager` 从系统钥匙串读取，不写出或展示。使用生产 `AgentRuntime` / 模型适配器、真实本地临时目录目标和 RequestApproval 权限，调用 `followup/start`，模型实际产生 `ask_user_question`，driver 返回等待后活动仍为 Waiting，再经 `answer_question` 继续模型请求，最终会话 Idle 且活动清理。最终通过运行耗时 49.56 秒。

此真实模型用例**保持 Petdex 总开关关闭**，验证真实 Agent 与纯内存活动跟踪，不验证 Petdex HTTP 或动画。没有把成功/失败文本注入模型响应。SSH/SFTP/AI 同时运行的原生完整显示与恢复矩阵仍待验收。

前端新增 `preferences.test.ts` 直接测试生产偏好逻辑：分类迁移/校验、基于确认值的稀疏合并（成功分类保留、被拒绝修改不渗入后续请求）、双语可读 label。已有 UI 回归补充分类开关总开关关闭时仍可用、默认值、描述关联和统一尺寸；既有配置串行/失败回退、诊断恢复和预览 Toast 用例继续通过，其 fixture 结果不作为原生 IPC 成功证据。

## 阶段 3 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run src/lib/petdex/__tests__ src/stores/__tests__/appStore.test.ts src/components/workbench/__tests__/settings-panel.test.tsx` | 最终 6 files、63 passed |
| `pnpm test` | 284 files passed、1 skipped；2512 passed、2 skipped。之后仅抽出已存在的稀疏配置合并逻辑并补 1 项直接回归，由最终局部测试与 `tsc --noEmit` 覆盖 |
| `pnpm build` | TypeScript / Vite 通过；保留已有分块及静态/动态导入警告。上述最后的纯函数抽取另经最终 TypeScript 检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 1104 passed、52 ignored；独立探针 5 passed，main/doc 0 tests。之后只收紧不完整回合的终态分类并补回归，由最终 Petdex 测试覆盖，未重复无变化全量检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 最终 37 passed、3 ignored |
| `SHELLSPAN_PETDEX_AI_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml petdex::agent_activity_tests::configured_model_question_and_answer_follow_real_driver_lifecycle -- --ignored --exact` | 1 passed；真实模型提问/等待/回答/继续到 Idle，不是桌宠显示验收 |
| `SHELLSPAN_PETDEX_RUNNING_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml petdex::tests::running_macos_petdex_accepts_production_transport -- --ignored --exact` | 1 passed；已有真实 Petdex 接受生产客户端短 waving 请求 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`git diff --check` | 通过 |
| `pnpm check:rust:includes`、`pnpm check:ai-styles`、`pnpm check:llm:catalog` | 通过；47 include 文件、55 models、4 negative fixtures |

测试日志在本机 `/tmp/shellspan-stage3-{frontend,build,rust-full,rust-related,related,ai-live,petdex-live}.log`，不是持久交付依赖。未创建 commit、tag、推送或下一阶段会话。

## 阶段 3 界面、真实环境与剩余限制

本节为阶段3当时记录；当时缺少的原生入口、分类/Toast和真实显示证据已由阶段5补齐，当前覆盖边界见[最终审计](#阶段-5-最终审计)。

通过真实 `pnpm dev` 页面检查 1280×800 与 760×650 的中文/英文 Petdex 区域：分类名称和开关无重叠，控件均为 32×18.398px，沿用共享 Switch。Tab 从总开关进入 SSH 分类，Space 可触发分类更新；浏览器无 Tauri IPC 时出现一次操作失败 Toast，AI 开关回退关闭且焦点保留。总开关关闭不禁用分类。没有注入状态或业务数据；页面实际展示读取/订阅不可用，不将其当作原生成功状态验收。截图位于 `/tmp/shellspan-stage3-petdex-zh-wide.png`、`/tmp/shellspan-stage3-petdex-zh-narrow.png`、`/tmp/shellspan-stage3-petdex-en-wide.png`。

开发版原生 ShellSpan 已启动并加载既有配置，但 UI 自动化无法识别未打包开发可执行文件或 `com.shellspan-dev`，均返回 Invalid app；因此改用上述真实生产 AgentRuntime 端到端方法。已终止本会话启动、父进程链核实的开发进程，未停止未知进程。原生分类保存成功、处理中状态、连接成功/预览覆盖 Toast 与原生键盘交互仍待可用原生 UI 入口补验。

2026-09-29 11:28 CST 附近再次核对 whoami：PID 18362、inProcess true，`lsof` 可执行路径为 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`；真实通信测试在读 token 前也自行核验身份。未停止 Python、未安装/启动/重启 Petdex，未新增关闭时全局 idle 清理。HTTP 成功不等于已入队或已显示。

阶段 4 交接（按用户最新范围）：仅完善 Petdex 设置诊断、重新检测和反馈入口，复用 `PetdexCategories`、前端 `preferences.ts` 的稀疏合并及按来源短提示槽，保留新的 AI 存储观察/driver 代际边界。部署来源、部署分类、部署生命周期全部延期，不在阶段 4 接入；原部署规划保留未勾选，不作为本轮完成门槛。未来接入部署时仍须由整次运行所有者持有 guard，并只按可靠父子标识处理 SFTP 子操作。保留阶段 1 诊断修订号与订阅恢复、阶段 2 预览反馈和取消锁；不扩展未经支持的租约/来源释放/抢占能力。阶段 5 仅验收 SSH/SFTP/AI 与通用可靠性：实际动画时长、Petdex 重启令牌轮换、ShellSpan 退出重开、持续状态残留和多应用共享队列仍未验收。

## 阶段 4 设置完善与验证

只修改 Petdex 设置 UI、其诊断/通信适配、双语文案和反馈表单。没有修改部署、其他设置或共享 UI；保留阶段 0–3 未提交改动，未提交或推送。

- 新增 `petdex_check_health` 并注册，类型化 IPC 与 Ajv 验证齐全。只读匿名 health 与状态 POST 共用请求锁和取消代际，关闭不通信，1500ms 包含排队上限。它不读 token、不创建挥手、不清理业务、不修改诊断或历史成功发送时间；`reachable` 明确不等同于认证成功。
- 设置详情通过现有 Collapsible/Button 按需展开，显示有限状态建议、可读目标动作、健康检查有限结果、历史成功时间与无记录空态。历史时间不保证当前可用。主动完成 Toast 与就地结果分工，后台恢复无 Toast；同步 busy ref 防重复触发，原有操作代际阻止过期反馈。
- “反馈问题”仍打开固定 `petdex-phase3-feedback.yml` URL，保留文件名以兼容既有链接；表单增加问题分类，聚合评估同意变为可选。没有打开或提交 GitHub 反馈，也没有附带/上传应用信息。

| 验证 | 结果与边界 |
| --- | --- |
| 初次相关前端回归 | 6 files、63 passed |
| 最终相关前端回归（含新诊断组件） | 7 files、66 passed；新增直接组件双语 Enter/Space/焦点/空态和有限健康契约测试，无新增 mock |
| `pnpm test` | 285 files passed、1 skipped；2516 passed、2 skipped；其后只有两条双语说明调整，由最终相关回归覆盖 |
| `pnpm build` | TypeScript/Vite 通过；既有分块和动态导入警告保留 |
| 完整 Rust 串行重跑 | 1106 passed、52 ignored；独立探针 5 passed；main/doc 0 tests 全部通过。首次与打包并行时 doctest 依赖工件读取失败，串行重跑已通过 |
| 真实 Petdex 回归 | `SHELLSPAN_PETDEX_RUNNING_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml running_macos_petdex_accepts_production_transport -- --ignored` 最终 1 passed；生产 health 在已登记 SFTP Running 活动期间不改变目标/诊断，随后既有短挥手认证 POST 成功；不证明实际显示 |
| 关闭与取消 | 新增生产 check_health 回归：关闭不通信；等待请求锁时关闭可立即取消，诊断保持关闭；完整 Rust 已覆盖 |
| 格式与规则 | `cargo fmt -- --check`、`pnpm check:rust:includes`、`pnpm check:ai-styles`、`git diff --check` 通过 |

本机日志：`/tmp/petdex-stage4-{related-final,all-front,build,rust-final,live-final,native-build}.log`。完整测试包含仓库既有 mock/fixture，不作为真实端到端证据；新增通信验证只用已运行真实 Petdex。11:41–11:47 CST 核验 whoami PID 18362、inProcess true，`ps` 原生路径 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`，真实用例在读凭证前再次核验。Python PID 712 保持原状，未安装、启动或停止 Petdex，未发全局 idle 清理。

## 阶段 4 界面证据与阶段 5 原生入口交接

本节为阶段4当时记录；空白WebView已修复、原生成功态已补验，当前结论见[最终审计](#阶段-5-最终审计)。

浏览器真实 `pnpm dev` 页面检查 1280×800、760×650 的中文/英文设置：展开后的正文可滚动，Petdex 内容无横向溢出（英文 panel 740/740px、522/522px），四种按钮高度均 32px、图文 gap 4px。Enter/Space 展开折叠后焦点保留，Tab 可到反馈按钮。无数据注入；浏览器缺 Tauri IPC，显示真实读取/订阅失败与无通信空态，**不证明原生成功态、检测中或 Toast 成功结果**。截图在 `/tmp/shellspan-stage4-petdex-{zh,en}-{wide,narrow}.png`。

阶段 5 可直接使用的打包入口：

```bash
pnpm exec tauri build --debug --bundles app --config src-tauri/tauri.dev.conf.json --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}'
```

- 产物绝对路径：`/Users/zhengbiwen/Developer/my/ShellSpan/src-tauri/target/debug/bundle/macos/ShellSpan.app`。
- 可执行文件：上述 `.app/Contents/MacOS/ShellSpan`；配置标识 `com.shellspan-dev`，临时构建参数关闭 updater 产物、使用 ad-hoc 签名，没有改仓库构建配置。
- `cua.getApp` 按完整 app 路径初次启动超时，但进程已启动；随后 `cua.getApp('com.shellspan-dev')` **成功识别**窗口。无需重复未打包 executable 的 Invalid app 路径。
- 实际证据：原生 AX 树仅有 standard window、菜单、scroll area 和 `HTML content Description: ShellSpan, URL: tauri://localhost`；截图为浅色空白 WebView，仅左上角有小图标，Cmd+, 未打开设置。后续读取仍无内容变化。证据文件 `/tmp/shellspan-stage4-native-blank.png`、`/tmp/shellspan-stage4-native-ax.txt`。不能据此宣称原生诊断 UI 通过，也未推断空白根因。
- 打包日志 `/tmp/petdex-stage4-native-build.log`；复现启动 stdout/stderr `/tmp/petdex-stage4-native-run.log`。应用日志位置为 `/Users/zhengbiwen/Library/Logs/com.shellspan-dev/frontend.log` 和 `backend.log`；这些是累计日志，后续须按本次启动时间筛选，不能把历史错误当作空白根因。这里不复制原始日志或用户数据。
- 本次复现 stdout/stderr 在 11:48:35 记录 `tauri_runtime_wry: web content process terminated`，仅能确认 Web 内容进程终止，根因未确认。本次启动的两个打包开发进程均在核对可执行路径后终止，没有关闭用户应用或 Petdex。

阶段 5 继续补原生健康结果/历史时间/预览覆盖 Toast 与配置成功态，及 SSH/SFTP/AI 并发、等待、取消、Petdex 重启令牌轮换、ShellSpan 重开、多应用和持续动画残留。部署所有延期项继续未勾选。保留诊断 revision、订阅读取恢复、稀疏配置队列、来源提示、独立预览、取消代际及 AI driver 代际边界，不引入租约、来源释放、抢占或全局 idle 清理。本会话不创建下一阶段。

## 阶段 5：原生启动修复与真实联调（过程记录）

2026-09-29 11:52 CST 在打包开发应用中右键 → Inspect Element → Console，直接读到 `EvalError: Refused to evaluate a string as JavaScript`，调用来自 Petdex 诊断模块的 Ajv 顶层 schema 编译。CSS 和 HTML 已加载，React root 为空；这确认了一个独立于此前 WebContent terminated 日志的启动阻断原因。

修复将 schema 移入 `src/lib/petdex/diagnostic.schema.json`，通过官方 Ajv standalone 生成 ESM 校验器，保留严格字段/枚举/数值检查及类型守卫。原生 CSP 未改，未添加 unsafe-eval。更新 schema 后运行 `node scripts/generate-petdex-validators.mjs`；就近回归以 Node 禁止字符串代码生成模式导入实际校验器，并执行 `--check` 验证生成内容没有漂移。重新使用上节相同正常构建命令打包后，原生工作台、设置及 Tauri IPC 正常。没有手改构建产物，也没有注入模拟 IPC。

| 验证 | 本阶段结果 |
| --- | --- |
| `pnpm exec vitest run src/lib/petdex/__tests__` 与新增 CSP 回归 | 原有 16 项及新增 2 项通过，后续完整回归覆盖最终版本 |
| `pnpm test` | 286 files passed、1 skipped；2518 passed、2 skipped |
| 上节 `pnpm exec tauri build --debug --bundles app ...` | TypeScript/Vite 和原生 app 打包通过；125.02 MiB |
| 串行 `cargo test --manifest-path src-tauri/Cargo.toml` | 1106 passed、52 ignored；独立探针 5 passed；main/doc 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`pnpm check:rust:includes`、`pnpm check:ai-styles`、`pnpm check:llm:catalog` | 通过，47 includes、55 models、4 negative fixtures |

日志位于 `/tmp/petdex-stage5-{native-build,frontend,rust,real-ssh,ssh}.log`。图片和 AX 证据在本会话的原生 CUA 工具记录中；没有把开发浏览器结果升级为原生成功证据。

### 原生设置和恢复证据

- 初始偏好为总开关 false、SSH true、SFTP true、AI false。关闭时展开详情显示“尚无成功通信记录”，分类可以成功保存。
- 启用后显示“已连接”；已有持久 AI 等待被同步为“等待”。测试动作显示一次“测试请求成功，预览被任务失败或等待用户状态覆盖”。关闭 AI 分类后目标回到空闲，测试动作显示“已请求挥手预览”；不把这条 Toast 当作动画证据。
- 11:57:23 成功发送后主动重新检测，显示“健康接口响应正常；未验证认证，也未发送动作”，历史发送时间保持 11:57:23。后台周期通信更新时间时没有主动检测/预览 Toast。
- 原生正常退出确认后重开，验证总开关 true、SSH false、SFTP false、AI true 四项均保留。随后分类恢复初始值。
- 受控 Petdex 重启：先关闭 ShellSpan 联动，再核对 `/whoami` PID 18362 和安装目录可执行路径，停止该已确认进程；Python PID 712 始终保持监听。启动同一安装产物后 `/whoami` PID 92293、inProcess true，`ps` 路径再次一致。仅在内存比较令牌摘要，确认令牌轮换，不输出令牌或摘要。同一 ShellSpan 进程重新启用后显示“已连接”。**这是暂停通信后的轮换重连，未验证始终开启时自动恢复**；后者不能在 Python 接管端口期间发送令牌。

### 真实 SSH/SFTP/AI

使用已有 `shellspan-ssh-e2e:local` OpenSSH 镜像和独立 Compose project：`docker compose -f tests/ssh-e2e/compose.yml -p shellspan-petdex-stage5 up -d --wait ssh`。仅绑定 loopback 22222，没有接触已有远端或其他业务容器。新建专用原生连接 `Petdex Stage 5 Local`；主机指纹与容器 `/etc/ssh/ssh_host_ed25519_key.pub` 的 `ssh-keygen -lf` 输出核对一致后信任。

新建连接时曾等待系统钥匙串：`sample 79554 1 1 -file /tmp/petdex-stage5-shellspan-sample.txt` 显示主线程位于 `CredentialManager::retrieve_profile_password` → `macos_keychain::get_generic_password` → `SecKeychainFindGenericPassword`。CUA 禁止访问 SecurityAgent，已请求用户自行处理，没有代点或绕过。12:04 后调用继续、原生 UI 恢复；该阻塞与 CSP 原因不同。

- 真实独立生产入口验证：以 `SHELLSPAN_E2E_SSH_FIXTURE=1`、loopback 22222 和仓库公开测试账号环境运行 `cargo test --locked --manifest-path src-tauri/Cargo.toml execution::fixture::isolated_ssh_sftp_end_to_end_reviewed_execution_uname --lib -- --ignored --exact`，1 passed。主体验证SSH执行uname、输出和执行注册表清理；不能因为测试名称含SFTP就声称验证了上传或下载，上传证据为前述原生操作。
- 原生 SSH 连接成功，终端执行 `uname -s`。原生 SFTP 将实际 124.9 MB 构建产物上传到独立容器；进度为 12.5 MB/124.9 MB、46.8 MB/s 时桌宠截图显示侧向奔跑。完成后恢复站立，本地和远端 SHA-256 一致。
- 独立终端 AI 会话真实调用 `ask_user_question`、等待回答；回答后请求 `uname -s` 审批。等待期间发生第二次 SFTP 请求，因远端同名文件存在真实失败。审批过期后模型自行重试；允许一次只读命令后返回 Linux、exit code 0，模型回到空闲。没有替代模型或注入终态。
- 在已有活动期间开启 AI 分类，原生详情目标为等待；本次 AI 完成后目标仍为等待，其他已有持久等待未被清除。未修改其他会话内容。后文已补同 TTL 的短动作截图；真实业务失败后恢复等待的完整显示序列及取消/网络中断组合仍需补验。

### 显示层观察边界

临时 `/tmp/petdex-stage5-probe.mjs` 使用 Node 内置 fetch、JSON 和 fs，发送前匿名核对 whoami、PID 可执行路径，读取令牌后再次核对身份；禁止重定向，有限超时，只输出动作/时长/状态码/queued/时间。此脚本是实际协议探针，**不替代生产业务联动**。

- waving：04:11:56.936 UTC 发送 duration 10000；04:12:06.302 截图仍举手，04:12:11.227 回到站立。
- jumping：04:12:21.472 发送 duration 10000；04:12:26.429 截图呈跳跃姿态，04:12:34.509 回到站立。
- failed：04:12:38.385 发送 duration 10000；04:12:42.207 截图呈低垂眼神的失败姿态。
- running：04:13:14.834 发送 duration 1000；04:13:20.272 仍在侧向奔跑，确认 duration 不是自动释放租约。此时 ShellSpan 总开关关闭。
- waiting：进一步核对固定版本 [sprite.zig](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/sprite.zig) 与本机 Uika spritesheet，waiting 使用 row 6（从 0 开始）、6 帧，包含抬手至胸前的帧；idle 使用 row 0。04:23:40.507 UTC 发送 duration 10000，04:23:51.323 开始的连续原生截图确实捕获胸前抬手和落手帧，超过 duration 后仍等待。部分帧近似 idle 属于素材表现，不是协议缺失。
- idle：04:24:19.661 UTC 显式协议请求后，04:24:27.988 截图为对应站立帧。上述六动作均已有真实显示依据，仍不宣称精确帧时间或业务短 TTL 全部通过。
- Petdex 设置中 Codex 集成显示 Connected；已有其他客户端可能向共享队列发送动作。未停用用户的集成，不把非隔离观察声称为精确队列或 1200/2500ms 计时验收。

该轮结束时尚有自动恢复、取消和失败→等待显示待补；这些后续结果已收录在[最终审计](#阶段-5-最终审计)。未隔离Codex等所有其他写入，不宣称穷尽多应用组合；部署继续延期。

### 真实取消缺陷及修复复验

原生上传点击取消后，12:18:35 后端记录 `Cancelling upload` 和 `upload cancelled`，随后同一个 operation_id 再次进入 Uploading。前端 `useSftpConnection` 在批次失败后重新登记失败子集，`addOperation(status: running)` 覆盖了取消状态，使重试门禁放行。修复 `transferStore.addOperation`：正在 cancelling 的记录不被批次重登记覆盖，保留路径、进度和取消意图，直到实际工作结算；显式后续重试仍可在结算后开始。没有修改传输 UI。

新增上传/下载两项直接调用生产 store 的回归，没有 mock；`pnpm exec vitest run src/stores/__tests__/transferStore.test.ts src/hooks/__tests__/useSftpConnection.test.ts` 54 passed。最终 `pnpm test` 2520 passed、2 skipped，286 files passed、1 skipped；相同原生命令重新构建通过。日志 `/tmp/petdex-stage5-cancel-related.log`、`/tmp/petdex-stage5-cancel-build.log`、`/tmp/petdex-stage5-final-frontend.log`。Rust 未改，沿用本阶段已通过的 1106+5 串行结果。

为延长真实传输窗口，独立容器 CPU 从初始 NanoCpus=0 临时设为 `--cpus 0.1`，不是替代传输服务或伪造进度。新构建连接 SFTP 时再次等待系统钥匙串；原会话已请求用户处理，原生取消修复仍待复验，不把纯状态回归当作真实通过。

受控 `docker stop --time 1 shellspan-petdex-stage5-ssh-1` 后原生终端识别断开、AI 显示当前不可用；随后 `docker start` 恢复该容器。失败动画短窗口未捕获，不记为动画通过。同一时段还记录到一次 Petdex transport-unavailable 后后台 applied，无新增 Toast；不是 Petdex 重启测试。

日志审计只输出检测结果：当前真实 token 未出现在前后端累计日志中，2026-09-29 的 Petdex 专属后端日志为有限 applied/transport-unavailable 等类别，没有认证头或原始响应。传输模块原有审计日志包含本机测试路径和操作 ID，不会发送到 Petdex。未新增业务调试日志，未修改部署来源/分类/生命周期或共享 UI。

### 短时长与共享队列补充证据

通过 CUA 连续采样实际 Petdex 窗口，将时间与每张原始截图一起暂存在本会话运行时，再选取边界帧展示；不修改图片、不使用状态镜像替代截图。

- `node /tmp/petdex-stage5-probe.mjs waving 1200 6000`：04:28:05.757 UTC 请求成功；04:28:06.854 和 06.930 仍举手，04:28:07.280 已为空闲。这支持 1200ms 的实际短停留及随后恢复，观察精度为采样窗口，不声称零延迟或精确到单毫秒。
- `node /tmp/petdex-stage5-probe.mjs failed 2500 10000`：04:28:52.382 请求成功；04:28:53.142 蜷坐失败姿态，04:28:54.332 仍为失败帧，04:28:54.964 已为空闲（约 2.58 秒）。这些是与业务 TTL 相同的真实协议请求，业务仲裁发送剩余时长仍由生产代码及回归验证。
- 04:26:37.312 请求 waving 20000，37.390 请求 running 1000，两次均 queued=true。紧接着 GET state 返回 running-left/counter 76；04:26:56.006 原生截图仍挥手，04:27:05.256 才显示奔跑。这直接证明队列不被后来动作立即抢占，GET state 是入队镜像。
- 同时启用的 ShellSpan 在 12:27:16 CST 周期发送空闲后，04:27:38.388 UTC 截图恢复站立；真实 ShellSpan 与独立协议客户端确实影响同一显示队列。Codex 集成仍显示 Connected，没有停用它；因此不宣称已隔离所有其他写入或完成全部应用组合。
- 真实匿名 health=200、缺失 token 的 state POST=401；token 文件模式 0600。没有修改或损坏真实凭证制造错误。

上一轮结束时的环境条件：新 ad-hoc 构建的钥匙串提示阻止取消复验，Python PID 712 继续占用 `*:7777`，AI 权限恢复请求待答复。以下续验更新了当前结果，不能把未回复当作权限恢复授权。

等待输入时的环境交接：Petdex PID 92293 保持运行，符合初始运行状态；Python PID 712 未改。独立 Compose project 已执行 `docker compose -f tests/ssh-e2e/compose.yml -p shellspan-petdex-stage5 down` 清理，容器、网络及容器内临时上传文件均不再保留，既有 Abu 数据库容器不受影响；本机镜像、构建产物和验收日志保留。后续复验需重建该独立容器、创建空目标目录，并重新核对生成的主机指纹，不能绕过主机密钥变化提示。ShellSpan 新构建仍阻塞在凭据读取，联动总开关暂为 true、SSH/SFTP true、AI false；输入到达后先完成复验，再恢复初始总开关 false 并正常退出。专用测试连接和已结束的测试 AI 会话明确命名，未覆盖已有连接或会话。未创建 commit/tag/push 或其他会话。

## 阶段 5 续验：取消通过与端口误接防护

用户要求继续后，原生钥匙串阻塞已解除，当前设置为总开关和三个分类都开启。重建独立 OpenSSH 容器，核对新的公钥指纹后在原生确认信任。使用新的空目标目录 `/home/shellspan/stage5-cancel-fixed`，实际上传到4.6MB时点击取消，8.8MB处显示“已撤销”。12:36:38只有一次 Uploading，12:36:39后端确认 `upload cancelled`，随后目录为空且没有同operation_id重试。**上传取消修复的原生复验通过**；下载共享状态路径已由直接回归覆盖，未把它声称为独立下载端到端验收。

本轮发现实际端口误接事件：旧Petdex PID92293于12:35:36附近退出（其日志末尾为 context_menu/stop，本回合未主动执行该停止），Python712接管loopback端口。旧生产客户端随后记录 rejected；独立探针收到whoami404/HTML后在读取token前停止。发现后立即通过原生设置关闭联动。**旧生产客户端的认证头可能已发送到本机Python，不能宣称本轮没有凭证暴露；没有证据表明Python记录或转发了该头。** 恢复官方Petdex并进一步受控重启轮换令牌，没有输出凭证或摘要，Python始终未修改。

针对已知误接增加生产兼容门禁，详见协议：令牌读取前、401刷新读取前和每次认证POST前均检查匿名health/whoami，最多1KB响应、有限超时、同锁/取消，不信任匿名信息作为安全身份，不宣称消除TOCTOU。非JSON、契约不完整、不正确端口/PID和超限纯生产解析回归已增加。既有TCP替代服务测试仅适配新增GET契约，保留401轮换/不重复认证/取消断言，使用已锁定的成熟httparse替换原手写请求头解析；没有新增替代服务或产品测试绕过。这些fixture只算客户端回归。

最终 `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib`：46 passed、4 ignored。新增绝对到期、整次1500ms预算、Expired不伪造诊断、手动超时只清本次预览并保留业务提示的纯生产回归。真实生产客户端分别验证：

- `SHELLSPAN_PETDEX_RUNNING_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml petdex::tests::running_macos_petdex_accepts_production_transport --lib -- --ignored --exact`：1 passed，实际Petdex匿名检查及认证发送成功。
- 先确认旧原生应用联动关闭、核实安装路径后受控停止Petdex51462，仅剩真实Python712；`SHELLSPAN_PETDEX_FOREIGN_E2E=1 SHELLSPAN_PETDEX_FOREIGN_PID=712 cargo test --manifest-path src-tauri/Cargo.toml petdex::tests::existing_foreign_service_is_rejected_before_authenticated_delivery --lib -- --ignored --exact`：1 passed，生产路径在匿名404检查处Rejected，未进入认证发送。
- 用CUA恢复官方应用，whoami新PID85981与可执行路径一致；仅在内存比较重启前后摘要，tokenRotated=true，未输出摘要。该验证真实服务兼容失败关闭，不保证原子身份绑定。

日志 `/tmp/petdex-stage5-guard-{related-final,live-native,live-python,rust-full,rust-final,native-final}.log`。边界修复后再次串行完整Rust与原生打包；前端源码未再改变，沿用2520项完整结果，原生打包包含最终TypeScript/Vite构建。

短动作现在保留绝对expires_at，经过多次匿名检查或401重试也不重置TTL。整个尝试含锁等待限1500ms；手动2秒超时后drop请求，并在同代际锁内撤销本次preview，恢复之前连接诊断、重算业务目标。失败/Expired也清本次preview，避免后台补发；业务success/failed槽和较新preview保持不变。已经发出或被服务端接受的HTTP无法撤回，这个限制仍保留。

### 最终构建与持续开启自动恢复（13:04当时交接，后续收尾见最终审计）

- 最终完整 Rust：1114 passed、53 ignored；独立探针5 passed；main/doc通过。最终相关46 passed、4 ignored。格式、47个include检查和diff检查通过。
- 最终原生打包包含TypeScript/Vite构建，125.16MiB；日志 `/tmp/petdex-stage5-guard-native-final.log`。前端最终2520 passed、2 skipped，此后没有前端源码变更。
- 新原生应用PID35766成功启动，开启联动后保持开启、所有分类为true。12:59:58和13:00:03 CST认证发送成功，目标为真实恢复的AI等待。
- 在确认一次发送已完成后，受控停止已核实路径的Petdex85981；Python712保持原状。后台匿名检查在Python404处拒绝，原生状态变为“请求被拒绝”，历史成功时间仍为13:00:03，未弹出后台Toast。
- CUA重启官方Petdex为PID36116，whoami与安装可执行路径一致；内存比较确认token轮换。没有切换ShellSpan开关或手动测试，13:00:55后台自动恢复“已连接”，历史时间更新，截图显示waiting抬手胸前帧。**持续开启、误接拒绝、令牌轮换后自动恢复已通过**，但匿名检查与POST之间的TOCTOU仍是明确限制。
- 为补实际业务failed→waiting显示序列，最终ad-hoc构建再次打开本阶段SSH连接时等待系统钥匙串。原会话已协调处理，未操作SecurityAgent，也未扩大权限。该最后显示序列仍未勾选；之前的取消修复原生证据有效，不因新构建再次等待而撤回。

当前续验资源（13:04 CST核对）：保留最终ShellSpan PID35766和Petdex PID36116，不再无变化重建。独立 `shellspan-petdex-stage5-ssh-1` 容器运行、CPU配额0.1，真实测试文件位于容器内；结束验收后用该project的Compose down清理，不影响Abu数据库容器。Python712未修改，也已无需用户停止它来完成本次已验证的兼容拒绝/自动恢复场景。当前总开关、SSH/SFTP/AI均为true；AI分类在本轮开始前已由界面呈现为true，不能把旧交接的false当作当前值直接覆盖。恢复完全访问权限的确认仍未答复，保持请求批准。下一步是用户处理钥匙串后完成实际业务失败→等待的连续截图，然后关闭测试连接、按最终确认偏好恢复设置并正常退出；阶段5仍不标整体完成。

## 阶段 5 最终审计

2026-09-29 13:44 CST收口。本轮SSH/SFTP/AI及通用可靠性按计划的生产逻辑回归、真实业务和实际显示分层完成；未将任一层结果冒充另一层。阶段0的真实契约遗留项已回填，部署仍延期。本次收口没有再修改业务代码或重跑无变化测试。

| 计划项 | 完成证据 | 证据边界 |
| --- | --- | --- |
| 原生启动与设置可用 | Web Inspector确认Ajv动态编译被CSP拒绝；官方standalone校验器修复后多次原生启动、真实IPC正常 | CSP未放宽；禁止动态生成代码回归及schema同步回归通过 |
| 总开关、三分类、保存重开、中途启用 | 四项原生开关重开后保留；关闭期间AI分类保存成功；开启AI读取已存在等待，关闭分类目标回空闲 | 其他来源中途启用/乱序/代际由活动与分类生产回归覆盖，不声称每个组合都有独立逐帧录像 |
| 健康、认证、历史、空态、预览和后台静默 | 原生无记录空态、历史时间保持；匿名health200/缺token状态401；请求成功与等待覆盖Toast；故障和自动恢复无重复Toast | 原生成功证据为中文；双语宽窄、焦点/键盘由阶段1–4实际浏览器渲染和组件回归补充，浏览器无IPC结果未当作认证成功 |
| SSH与网络中断 | 真实容器SSH连接及uname；停止仅本阶段容器后原生断开；13:34:50再连接得到真实Connection refused | `isolated_ssh_sftp_end_to_end_reviewed_execution_uname`仅证明SSH命令/输出/注册表清理，不能证明独立下载 |
| SFTP运行、完成、取消 | 124.9MB真实上传期间桌宠奔跑、完成后站立，本地/远端SHA-256相同；最终取消修复在8.8MB显示已撤销、远端无临时文件、同ID不再重试 | 上传/下载重登记取消的两项共享store生产回归均通过；既有hook分别覆盖下载取消与失败子集重试。未独立原生复演下载全流程 |
| AI运行、提问、审批、继续、终态、并发 | 真实模型ask_user_question→回答→uname审批（含过期重试）→Linux/exit0→Idle；审批等待期间发生真实SFTP失败请求；本次完成未清除其他持久等待 | `agent_activity_tests`直接调用生产SessionStore/driver覆盖取消、恢复、并发和重复终态；未把这些测试当成AI取消的独立原生录像 |
| 失败短提示后恢复等待 | 停止测试SSH容器后13:34:50真实连接失败；连续210帧见下文，失败姿态之后回到waiting；原生目标随后为等待 | 没有直接POST failed代替这次业务触发；没有修改其他AI等待会话 |
| 六动作和时长 | 原生截图覆盖idle/waiting/waving/running/jumping/failed；1200ms挥手、2500ms失败及长时长观察；waiting素材行独立核对 | 不把HTTP200、queued或GETstate镜像当作显示；250ms精确下界等边界未做独立实测 |
| 重启、令牌轮换、保持开启自动恢复 | 最终原生总开关始终开启：Petdex停止后拒绝Python404并保留历史，重启轮换后13:00:55后台自动连通、显示waiting | 匿名兼容检查不是认证身份，TOCTOU仍存在；已发送或已入队HTTP不能撤回 |
| 退出、关闭、共享队列 | 挥手20秒期间后入队running不会抢占，镜像已变而显示未变；ShellSpan周期idle影响另一客户端；关闭/退出后等待仍残留 | 无来源release/租约/抢占，不增加全局idle清理；未穷尽所有应用组合 |
| 隐私、日志与范围 | Petdex正文仍只有有限state/duration，当前token未出现在应用日志；没有部署来源/分类/生命周期或无关UI变更 | 旧客户端曾有潜在本机令牌误发，见事件段；不能用日志无token推断历史网络绝无暴露 |

最后业务显示时序（UTC，对应本机13:34–13:35）：

- 原生错误与后台日志：2026-09-29 13:34:50 CST，`create_session`返回`failed to connect to 127.0.0.1:22222: Connection refused (os error 61)`。触发前原生诊断目标为等待。
- CUA连续帧覆盖05:34:51.185–05:35:03.469。51.185为蜷坐失败，52.002为跪坐，52.787为遮脸；53.861恢复正面动作，57.695明确抬手至胸前waiting。随后原生详情仍为“等待”，成功通信时间13:35:12。截图是工具记录中的实际窗口帧，未改图或注入状态。
- 13:37:42正常退出ShellSpan，05:37:42.917和45.460 UTC仍捕获waiting抬手，确认退出不清持续动作。另于13:42:28关闭总开关，界面已关闭、按钮禁用，05:42:33.554仍显示waiting抬手。随后恢复用户最新总开关true并正常退出。

最终检查：前端2520 passed/2 skipped；Rust1114 passed/53 ignored、独立探针5 passed；最终相关46 passed/4 ignored；TypeScript/Vite及125.16MiB原生app打包通过；格式、47个include、静态规则和diff检查通过。忽略项没有被计为通过，两个明确启用的真实Petdex/Python测试结果另列于上节。未新建mock服务；仅最小维护既有fixture并用httparse解析，新增回归直接调用生产逻辑。

明确未独立原生实测的内容：下载全流程、AI取消逐帧、所有客户端排列、服务端250ms精确下界/30000ms截断/429饱和/满队列；分别由生产回归、已有客户端分类测试或固定源码提供限定证据，不标为真实动画通过。它们不等同于未完成已指定的真实主流程，也不能因共享组件或测试名称而推断已实测。

收尾状态：唯一测试终端已正常关闭，UI确认无终端会话、无SFTP连接；本阶段Compose容器、网络及其临时文件已down清理，既有Abu数据库容器未动。ShellSpan已正常退出；Petdex保持运行，Python712未改。保存用户最新总开关及SSH/SFTP/AI均true，不把AI覆盖回旧交接false。AI权限保持请求批准，用户未授权恢复完全访问，未扩大权限。命名测试连接配置和已结束测试AI历史作为审计记录保留，没有永久删除；测试镜像、本机最终app和日志保留。没有commit、tag、push或新会话。
