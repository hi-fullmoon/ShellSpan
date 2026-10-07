# Agent Shell 沙箱阶段 1 验收

验收日期：2026-10-05（Asia/Shanghai）。阶段 1 五项策略与会话契约清单已实施，契约门禁通过；全仓格式检查存在一项任务外的既有差异。阶段 0 平台隔离门禁仍未通过，所有生产受限后端保持 `unavailable`，本报告不宣称真实隔离成功。阶段 2 与阶段 3 没有提前实现。

## 1. 开始状态与修改范围

开始时 `git status --short` 只有未跟踪的实施计划、阶段 0 验收和 `tests/agent-shell-sandbox-phase-0/`。已读取最新仓库 AGENTS、原计划、阶段 0 验收和 `src/lib/README.md`。保留阶段 0 的真实证据：macOS 硬链接越界、Linux 默认 Docker namespace 不可用、Windows 无 native runner；不移除测试后端的 `cfg(test)`，不启用无限制兜底。

没有修改组件、控件、布局、样式、会话设置或审批弹框。新增错误通过已有 AI 错误展示链提供中英文本；不增加策略选择或资源授权 UI。没有创建 commit/tag、推送、发布、安装远端依赖或修改服务器配置。临时资源使用系统 tempfile，未在仓库创建临时项目。

## 2. 清单与实际代码

| 阶段 1 清单 | 实际实现与证据 |
| --- | --- |
| 独立策略及跨端契约 | `sandbox.rs` 定义 `ReadOnly / Workspace / Host`，与 permissionMode 独立；Rust request/header、`session/created`、TS wire 类型、类型化创建 IPC、磁盘重放与前端投影同步。Session snapshot 输出后端能力事实。 |
| 按调用冻结、授权有效期、继承与失效 | Tool pipeline 给每次调用附加冻结契约并审计；NativeAdapter prepared token 保存同一事实。资源授权校验 session/call/target、开始和到期时间；冻结事实没有新增 Host 60 秒期限。execute 对比最新 Session Header 与关闭状态，继续现有 NativeEngine 的真实 terminal/profile/account revalidation。子 Agent 两条创建路径拒绝受限目标、descriptor 目标集合、工具/effect、执行方式和审批自动化程度扩大。 |
| 历史语义与默认意图 | 无字段历史日志仍按原账户行为解析；幂等创建和历史续接保持缺省语义。新建带项目目录的本地会话默认 Workspace，并在本机规范化目录；远端默认 Host。显式受限策略缺少有效本地根时拒绝创建。默认意图保持 Workspace，即使后端不可用也不改成 Host。 |
| 意图与实际能力 | 所有平台报告 `unavailable`，文件/网络/完整沙箱生命周期限制均为 false。模型上下文包含原始意图、effective policy、来源和与 snapshot 同源的能力事实；受限上下文没有可执行工具，不声称 Shell 有隔离。 |
| 协议与回归 | 新增 `protocol/agent/runtime/sandbox-policy.md`，扩展自包含 v5 schema 和新增事件；新增真实 store/runtime 契约测试、native admission、子权限、模型提示、前端投影和 Ajv schema 测试；相关与全量验证通过，格式基线差异如下。 |

`agent_runtime_create_session` 保留原命令名和 `src-tauri/src/lib.rs` 注册（现行第 340 行）；改为 async command，将配置、目录规范化与日志创建放入 blocking worker。`invokeCreateAgentRuntimeSession` 保持完整类型化 request/response，不在前端推断默认策略或实际隔离能力。没有新增裸 invoke 或漏注册命令。

## 3. 派发门禁与审计

当前受限 start 在解析模型、读取技能或执行工具前拒绝，写入 `sandbox/start_rejected`。策略仍为用户原意图，错误不自动重试，不静默转换到 Host。明确的 Host 策略通过新建会话请求表达；选择 UI 和空闲切换属于阶段 3，当前没有新增这些入口。

第二层 Tool pipeline 在技能、问题、会话工具、子 Agent/fleet 等分支之前校验冻结策略；Native prepare、recovery prepare 与生产 NativeAdapter execute 继续校验。独立的文件引用和技能发现入口也有门禁。受限会话不能借 Direct、普通终端注入、stdin、进程句柄、文件操作、HTTP、SFTP、MCP、部署/运维或委派进入现行无限制工具。用户自己操作普通终端/部署/SFTP 页面仍是既有用户功能，不宣称被沙箱保护。

`sandbox/call_frozen` 保存 call ID、格式版本、绑定版本、Session 创建时间、完整目标、执行方式、本地规范化根和资源意图；同一 Turn/Step/call 的并行探测或 barrier 重入不重复记录。绑定版本由项目绑定、执行方式变化、会话结束/续接事件 seq 更新，即使切回原执行方式，旧调用仍失效；真实磁盘重放保留版本。拒绝结果携带 `notStarted`、理由、同一冻结契约和能力事实；保留既有脱敏、审批、取消、审计与不确定副作用恢复机制。普通命令失败没有被重新解释为沙箱越界，也没有自动扩权或重放。

NativeAdapter 在 dispatch 前读取最新 `AgentRuntime.session`，比较 Header target、policy、execution surface 及 ended/archived 状态。实际 terminal 是否仍连接、SSH host/port/username/profile 是否改变，继续由 `native/runtime.rs::revalidate_target` 与既有执行链验证；本阶段没有拿 stored target 与自身比较作为重绑证据。

## 4. 授权生命周期与范围限制

冻结的策略事实不是临时资源授权。Host/历史请求没有新增 60 秒沙箱 deadline；现有操作审批 TTL 保持原实现。新资源授权类型有本次执行/会话绑定和独立有效期，验证在起点允许、到期时拒绝、跨 call/session/target 拒绝，不在审批后刷新旧授权期限。

资源授权实际签发、合并审批、网络目标授权、撤销与进程树清理是阶段 3；当前不提供签发 IPC。生产 `resourceGrants` 始终为空，Header 不保存 live grants，持久化冻结审计拒绝非空 live grants。恢复只重建策略事实，不能从日志复用授权。当前受限恢复仍由 start 门禁拒绝；恢复处理路径另外为未派发的受限审批保留取消规则，已派发但结果不确定的调用继续进入 reconciliation，不能重放。

阶段 1 的项目读写允许列表仅表达意图；敏感拒绝列表、专用临时/缓存、环境清理、远端规范化根和成熟执行后端未实现，不把这些意图列表宣称为已经完成的隔离 profile。不可用门禁保证这一未完成状态不会派发到无限制 Shell。普通本地终端尚未绑定项目时采用 Host 意图；后续绑定不会静默转换历史策略。显式选择受限本地策略时必须先有有效项目目录。

## 5. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml sandbox -- --quiet` | 较早的相关验证 16 passed，0 failed；随后新增的绑定版本测试在最终全量运行中通过。当前共有 14 项新增沙箱契约测试与 3 项既有沙箱相关测试，不能当作平台隔离验收。 |
| `cargo test --manifest-path src-tauri/Cargo.toml -- --quiet` | 最后继承校验与绑定版本修改后的全量结果：1177 passed，0 failed，54 ignored；另 5 项 `petdex_contract_probe` 集成测试通过，doc tests 0。单元测试运行 41.53s。 |
| `pnpm test --reporter=dot --silent` | 最后绑定版本投影修改后：291 test files passed / 1 skipped；2552 tests passed / 2 skipped，退出 0，运行 76.78s。 |
| 8 个相关前端/协议测试文件 | 137 passed；最终新增恢复错误本地化后，全量前端覆盖最终状态。 |
| `pnpm build` | TypeScript strict 与生产 Vite 构建通过，退出 0。 |
| `pnpm check:rust:includes` | 47 include 文件格式检查通过。 |
| `pnpm check:ai-styles` | AI 样式边界检查通过。 |
| `pnpm check:llm:catalog` | 55 个模型和 4 个负例验证通过。 |
| `git diff --check` | 通过。 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出 1；唯一差异为未修改的 `src-tauri/src/agent_runtime/native/mcp.rs:754` 既有 assert 换行。本阶段所有修改文件已按其原 include 上下文格式化，未顺手修改任务外文件。 |

相关前端命令：

```bash
pnpm test scripts/__tests__/agent-sandbox-contract.test.mjs scripts/__tests__/terminal-protocol-contract.test.mjs src/lib/ai/__tests__/sandbox-contract.test.ts src/lib/ai/__tests__/session-adapters.test.ts src/lib/ai/__tests__/agent-session-client.test.ts src/lib/ai/__tests__/agent-session-projection.test.ts src/lib/ai/__tests__/error-message.test.ts src/lib/ai/__tests__/session-error.test.ts
```

新 Rust 测试使用真实临时目录、真实 JSONL 写入/重放、生产 AgentRuntimeBuilder、真实 Session store 与未配置的 NativeToolRuntimeSlot admission 门禁；没有模拟隔离后端或虚构命令成功结果。前端/Ajv 测试验证 wire 与投影，不作为系统隔离证明。既有平台/控制器测试的 ignore 没有被当作成功证据。全量前端存在既有 React act/控件告警，Vite 有体积和混合 dynamic import 告警，均不影响退出码；本阶段没有修改这些任务外事项。

## 6. 未解决项与下一阶段条件

阶段 1 功能清单没有遗留的未实施项；临时资源授权签发/撤销和运行时切换按原计划留在阶段 3。全仓 cargo fmt 的任务外基线差异尚未处理，不能宣称所有仓库检查均绿。

阶段 0/2 依赖仍未解决：macOS 硬链接对象边界、最小系统读取、完整构建与缓存；Linux 原生 namespace/bubblewrap 可用性；Windows native runner 和成熟后端；子孙进程完整控制、网络目标授权、直连/socket/转发绕过、真实远端后端。当前全部保持未完成，不能因阶段 1 回归通过而开放受限执行或报告 full。

原会话应按上述实现和证据验收本阶段，再另建阶段 2 会话。后续要在统一后端真正具备声明能力后调整当前门禁，并继续保持失败即拒绝、无静默兜底、临时授权恢复失效和跨工具一致性。本会话停止在阶段 1。
