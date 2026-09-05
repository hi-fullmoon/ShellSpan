# 多模型适配实施进度

依据：[设计文档](llm-adapter-architecture.md)。用户要求按阶段完成，每阶段创建一个独立任务。此文件记录协调验收；子任务报告不能单独证明集成完成。

## 工作方式

- A → B → C → D → E 顺序实施，每阶段使用单独的 Codex 任务与隔离 worktree。
- 当前用户目录中的已有修改作为基线保留。隔离任务导入基线后单独提交阶段变更，协调任务审阅并将阶段差异集成回 `D:/Developer/ShellSpan`。
- 下一阶段从已集成的上一阶段结果继续。未通过验收的阶段继续在原任务修复，不新建重复阶段。
- 所有提交仅用于本地隔离和阶段交接，不自动推送或发布。

## 阶段状态

| 阶段 | 独立任务 | 实施 | 集成与验收 |
| --- | --- | --- | --- |
| A 协议提取 | `01a06d51-6643-74b3-b609-426a0120ac90` | 完成 | 已审阅、集成、编译验证 |
| B 统一能力 | `01a06d60-aa43-7293-9697-3be5508601a1` | 完成 | 已审阅、集成、编译验证 |
| C 配置与快照 | `01a06d89-bbc3-7d32-856e-91b40bf366cf` | 完成 | 已审阅、集成、聚合验证 |
| D 完整回放 | `01a06e03-02ac-7683-825e-ee4322911217` | 完成 | 已审阅、集成、聚合验证 |
| E Anthropic 协议 | `01a06e40-7275-7213-9d4c-cbd7a7fdd1b9` | 完成 | 已审阅、集成、聚合验证 |

## 最终验收清单

- [x] 三种原有协议独立实现，通用传输/类型/错误与 Agent 工具职责分开。
- [x] 精确模型目录、强类型兼容配置与统一 Rust 能力解析；前端、预检、压缩、请求预算共用事实。
- [x] 版本化 RouteStore、多模型连接、ModelSelection、后端设置命令与迁移。
- [x] PreparedModel/PreparedCall 固定配置、凭据和普通重试输入；日志完整记录无密钥请求快照。
- [x] Event v5 与显式 v4 转换器、前后端读写/投影/夹具同步；保留历史附件、调用 ID 和审批事实。
- [x] ReplayEnvelope 校验适配器、回放域、版本和内容对应关系；跨端点/账号隔离。
- [x] Anthropic Messages 通过适配接口接入，主 Loop/工具调度没有新增厂商判断。
- [x] 路由与模型设置 UI 完整接入；推理、图片和容量来自后端。
- [x] 协议、流式、并发、迁移、历史、图片与前端交互均有与范围匹配的验证证据。
- [x] 离线验证与实际服务验证分别记录；所有缺失证据明确保留为未完成。

外部证据缺口：

- [ ] 使用本机授权的 Anthropic 连接完成真实服务最小 smoke。当前环境无凭据，未执行且未声称通过。

## 当前记录

阶段 A 任务为 `01a06d51-6643-74b3-b609-426a0120ac90`（创建临时标识 `client-new-thread:b797d924-7c1a-444e-822b-97fbf6e14e6b`）。已确认其隔离目录为 `C:/Users/zhengbiwen/.codex/worktrees/5d95/ShellSpan`，基线提交 `f5ee96508f1a12f8165c857397a961b2371b15df`，基于源 HEAD `fc619f5bc7bb3c6618d86136897ad8525f8d4122`。wait_threads 已确认任务正在执行。

协调任务在原始工作目录执行的改动前基线：

- `pnpm test:ai:stage4:frontend`：4 个文件、55 项测试通过。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked`：通过；已有 `agent_runtime/images.rs` 的 `File` 未使用导入警告。

Windows 隔离任务须显式使用 `cargo +1.95.0-x86_64-pc-windows-msvc`：源目录具有 rustup directory override，worktree 不自动继承。阶段 A 首次使用 GNU 工具链遇到 vendored OpenSSL/Perl 配置失败，已定位并告知任务切换为基线 MSVC 工具链。允许以 `CARGO_TARGET_DIR=D:/Developer/ShellSpan/src-tauri/target` 复用构建缓存，manifest 始终指向隔离源码；协调任务避免同时占用同一 target。

阶段 A 已验收并集成：代码提交 `da6a06de552fbe8c3747c4c8e958f372bf8edb41`，报告提交/最终 HEAD `8fad5b7954e63edf4d8f10e8479eea7a666501cd`。协调任务导出 `f5ee965..8fad5b7` 纯阶段补丁，先 `git apply --check` 后应用，反向检查通过；29 个集成文件逐个与交付提交比对一致（仅规范化 CRLF/LF），原始目录 MSVC cargo check 通过。未提交或推送原目录已有修改。

最终测试：Rust llm 25 + ai 21 + agent_runtime 243 = 289 通过；前端 Runtime 94 + provider 55 + 图片/controller/v4 60 = 209 通过。14 个既有外部服务/bridge 测试 ignored，不列为通过。首次测试常量可见性错误已修复。详见 [阶段 A 报告](llm-stage-a-report.md)。

阶段 B 任务为 `01a06d60-aa43-7293-9697-3be5508601a1`，隔离目录 `C:/Users/zhengbiwen/.codex/worktrees/69af/ShellSpan`（创建临时标识 `client-new-thread:e778c557-6dc8-4fa3-a805-c0a8642db075`）。要求从已集成 A 的原目录建立隔离基线，完成统一 Rust resolver、强类型 compat、后端能力 DTO 以及 UI/图片/主预算/压缩接线；继续 Event v4，C 负责完整路由存储与 v5 迁移。

B 创建期间，源目录 HEAD 已由其他工作前移至 `df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`，B worktree 与之相同。已核实 A 的改动仍在源工作树中，要求 B 导入当前差异与未跟踪文件后继续，不回退源 HEAD。A 历史基线和上述验收记录保持有效。

B 已完成基线导入，snapshot 为 `383047edd1bc8838f2792ecbc08efe04825a1ec8`。后续集成只导出该 snapshot 之后的阶段差异。

B 中途设计审阅：移除 `maxOutputTokens <= contextWindow/4` 的任意限制，按真实容量与请求余量校验，并补高输出占比正例。显式模型声明使用现有 `ai.providers` 配置，不另建声明事实源，不给 v4 偷加字段；旧恢复入口仅可按 providerId、kind、baseUrl、原样 modelId 精确匹配配置，内存子任务保留解析后的父声明。C 必须完成自定义模型重启/子任务恢复及完整版本化快照；临时缺失声明只能显式报错，不能回落到默认能力。

B 前端审阅补充：v4 固定推理枚举期间，自定义声明不得发布无法提交的任意推理 ID；须明确拒绝，不能靠 TypeScript 强转伪装支持。C 必须开放字符串 ID、适配器 wire 值映射及 v5 持久化，解除该过渡限制。保存路径也必须验证所选 reasoningEffort，不只解析省略 effort 的能力信息。

B 恢复审阅补充：旧问答事件只含连接描述符，日志读取执行结构安全校验；续跑前通过既有设置恢复声明并完整校验。当前任务仍在执行，尚未达到集成门槛。图片分组报告 16 通过 / 2 ignored，LLM 分组报告 29 通过 / 9 ignored，最终以阶段报告和完整分组证据验收；此前中止的整组运行不列为通过。目录还须交付设计指定的 JSON Schema。

B 最终验收已完成，以上中途记录由本条最终证据更新。代码提交 `c060f31b0195dbb1b1f6e29053e9409dbe05d77f`，报告及计数更正后的最终 HEAD `57e1ad7b09e25c309a99e3ebf55d72387b6d10ae`。协调者检查实际命令输出、最终源码与 [阶段 B 报告](llm-stage-b-report.md)，导出 `383047e..57e1ad7` 纯阶段补丁；应用前检查、应用后反向检查均通过，57 个路径逐项与最终提交一致（包含删除）。原目录 MSVC cargo check 通过，仅原有 File 导入警告；原目录 schema 校验 54 个精确模型及 4 个负例通过。

B 最终 llm 分组 32 通过 / 9 ignored，主要 Runtime 99 / 1 ignored、图片 16 / 2 ignored，其他预算、压缩、事件、注册、子任务、文件引用及 ai 分组均通过，具体数量见报告。前端实际组合为 8 文件 119 通过、后续相关 2 文件 28 通过、最终 stage4 5 文件 62 通过，存在重叠不相加；已要求更正无运行证据的 121 计数。TypeScript 与 include 检查通过。新 schema/catalog/model-resolution 测试已接入阶段命令。内置容量仍为明确标注的应用预算；自定义容量仅受正整数、JSON 精确整数及 output<=context 约束。没有执行外部服务验证。

阶段 C 已创建并确认运行：`01a06d89-bbc3-7d32-856e-91b40bf366cf`（临时创建标识 `client-new-thread:88bf8350-285f-47e5-80bc-04ffc8cfdeb6`），隔离目录 `C:/Users/zhengbiwen/.codex/worktrees/f0aa/ShellSpan`，分支 `codex/llm-stage-c`。源 HEAD 仍为 `df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`，基线 snapshot `4d915278f1d475c09dce1a8221b7eb84e763608b`；任务确认 75 个导入路径逐项一致，wait_threads 确认 active/inProgress。

C 交接覆盖设计完整范围：RouteStore/ModelSelection 与后端多模型连接设置、版本化凭据和原子发布、预检至请求统一 PreparedModel/Call、完整无密钥请求快照、Event v5 全栈及显式离线 v4 转换、旧配置可恢复迁移和任意字符串推理 wire 映射；解除 B 临时恢复限制。D 所需 envelope/来源结构先纳入 v5，完整回放验证留 D。要求保留现有图片/工具/审批历史，并验证配置与凭据并发、重试冻结、自定义模型冷恢复、迁移失败原件保留及前端选择隔离。

C 中途审阅记录：v5 正常写入的 RequestHeader 必须含完整 Prepared snapshot/digest，v4 转换显式写 LegacyUnknown，生产 reader 明确拒绝 v4；v5 同批预留 ReplayEnvelope。离线转换不能仅在第二目录导出文件，须备份原件、与真实 SessionStore 写者互斥、完整验证后在正常会话路径原子切换，并以真实 v4 事件/附件/调用审批/未完成 Step 文件测试证明。RouteStore 保存输入不得允许客户端改写 migration 状态。前端必须按 routeId 独立分组并加载 route 的完整有效目录；models=None、modelOverrides、同名不同连接、空路由、revision 冲突均不得回退旧 aiSettings 事实或静默失败，能力缓存按 route/model/revision。

最终真实服务验收的准备：当前验证进程未配置 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `SHELLSPAN_LIVE_*`，源目录未发现 `.env` 或 `.env.local`。已异步询问用户阶段 E 使用的测试连接、模型 ID 和本机凭据存放位置，未要求在聊天发送密钥。此项待补充，不阻碍 C/D 的实现和离线验证，也不算真实服务通过。

阶段 C 已验收并集成。隔离基线为 `4d915278f1d475c09dce1a8221b7eb84e763608b`，实现提交 `4c9ef70fed3ab6c21f54b7ef66d9f4e9c19bab61`，报告及最终 HEAD 为 `a4c2db35297e9b4c4d10166bbe68ad1f1ceb009f`。协调任务审阅了 RouteStore、PreparedModel/PreparedCall、Event v5、完整请求快照、迁移和前端事实源；特别要求迁移临时输出与既有目标统一通过生产 `AgentSessionRecord::from_events` 校验，并补齐非法状态、摘要损坏、互斥 marker、幂等恢复及附件字节保持测试。无语义 Tauri schema 差异已清理。

协调任务以纯 `4d915278..a4c2db3` 二进制补丁集成；应用前检查和反向检查通过，71 个变更路径逐项与交付 Git blob 一致。源目录复验 `pnpm test:ai:stage-c` 通过：目录 54 个精确模型与 4 个负例、schema、8 个前端文件 109 项、7 个路由、6 个迁移、PreparedCall、冷子任务以及本地真实 HTTP 凭据恢复测试全部通过；`pnpm exec tsc --noEmit` 通过。隔离最终树另有全 Rust 634 通过 / 25 ignored、全前端 1,629 通过 / 1 skipped、cargo check 与生产构建通过。详情见 [阶段 C 报告](llm-stage-c-report.md)。阶段 D 只在既有 Event v5 上实现 ReplayEnvelope 的生成与严格回放，不再提升事件大版本。

阶段 D 任务为 `01a06e03-02ac-7683-825e-ee4322911217`（创建临时标识 `client-new-thread:60d9c489-6436-497f-9c9e-7c876a00ce54`），隔离目录 `C:/Users/zhengbiwen/.codex/worktrees/a124/ShellSpan`，分支 `codex/llm-stage-d`。任务已核对 110 个源路径并提交 baseline `56c7a15f53be107dc7644d6b2d7e1d108d804ab4`，规范化内容无差异。交接已限定 ReplayEnvelope 的适配器格式、无密钥来源绑定、跨端点/账号隔离、内容/工具/推理/图片对应校验、重启/并发稳定性以及受控本地 HTTP wire 断言。

阶段 D 已验收并集成。实现提交为 `7f2d415bb467e0a9c467ad189e67118e31bc049e`，报告及最终 HEAD 为 `486318830908506725be5c684c9919695cbb41a1`。协调任务审阅了 Event v5 严格 ReplayEnvelope、三个既有适配器的 ReplayCodec、同域白名单恢复、跨域清除、工具 ID 对应、图片引用绑定、生产 reader 校验以及 UI/raw 投影边界；特别要求同域恢复后也移除 envelope 本体，并验证 raw `all_events` 与重启保留、公开分页脱敏。

协调任务以纯 `56c7a15..4863188` 二进制补丁集成；应用前检查和反向检查通过，29 个变更路径逐项与交付 Git blob 一致。源目录复验 `pnpm test:ai:stage-d` 通过：继承的 C 门禁、1 个正例与 7 个负例 schema、7 个 replay 单测、1 个跨域本地 HTTP wire 测试和 1 个 UI/raw/restart 测试全部通过；`pnpm exec tsc --noEmit` 与 MSVC `cargo check --lib --locked` 通过。隔离最终树另有全 Rust 644 通过 / 25 ignored、全前端 1,629 通过 / 1 skipped及生产构建通过。详情见 [阶段 D 报告](llm-stage-d-report.md)。阶段 E 从该结果增加 Anthropic Messages 协议及其独立 replay codec。

阶段 E 已创建并确认运行：`01a06e40-7275-7213-9d4c-cbd7a7fdd1b9`（临时创建标识 `client-new-thread:76ac69ec-76ec-4ddc-86eb-21332c43e88b`），隔离目录 `C:/Users/zhengbiwen/.codex/worktrees/1ed7/ShellSpan`，分支 `codex/llm-stage-e`，baseline 为 `6746c42e19e896ab6a5bbe38215e6dfcfae76493`。任务由当前 working-tree 状态创建，86 个源状态路径集合已核对一致并包含 A-D 和阶段 D 报告；随后实施 Anthropic Messages、专属 ReplayCodec、目录/配置/UI 与受控本地 HTTP 协议验证。真实服务仅在本机已有授权连接时执行，否则明确保留为外部证据缺口。

阶段 E 已验收并集成。实现提交为 `eebc5518b0991cd4136b68216dc7a807274a81a8`，报告及最终 HEAD 为 `ac207f84ea444ae1e811ece533910137f64e31ef`。协调任务审阅了独立 Messages 请求/SSE 状态机、官方稳定 headers、三款精确 Claude 模型目录、adaptive thinking、thinking signature/redacted thinking、并行工具结果顺序、图片投影、usage、错误/取消/三类超时、Anthropic ReplayCodec、`/v1/models` discovery、RouteStore 和设置 UI。Event 保持 v5，主 Loop 与工具调度未增加厂商判断。

协调任务以纯 `6746c42..ac207f8` 二进制补丁集成；应用前检查和反向检查通过，29 个变更路径逐项与交付 Git blob 一致。源目录复验 `pnpm test:ai:stage-e` 通过：57 个精确目录模型与 4 个负例、A-D 聚合回归、Stage E schema、7 个前端文件 65 项、6 个离线 Anthropic 适配器测试、1 个 discovery、7 个 replay 和 9 个 route 测试通过；Anthropic live smoke 作为 1 个显式 ignored 测试，未计入通过。`pnpm exec tsc --noEmit` 与 MSVC `cargo check --lib --locked` 通过。隔离最终树另有全 Rust 652 通过 / 26 ignored、全前端 1,630 通过 / 1 skipped及生产构建通过。详情见 [阶段 E 报告](reports/llm-stage-e-report.md)。
