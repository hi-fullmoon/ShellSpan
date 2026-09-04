# AI Runtime / DeepSeek Harness 差距修复验收清单

> 当前状态（2026-09-04 Stage 7）：累计实现已安全接入 main 工作目录，HEAD 保持 `31ce4343`；macOS、本地 HTTP、隔离 Linux SSH 和 Chromium 门禁分别验收。最终证据见 [Stage 7 验收报告](ai-runtime-stage7-validation.md)；交付见 [交接说明](ai-runtime-handoff.md)。Windows 原生编译/执行/junction 仍为 NOT RUN；外部 live 为 3 PASS / 5 SKIP，不能据此宣称所有 Provider 或所有平台完成。没有提交、暂存或推送。

本清单记录 2026-09-04 审计之后的修复范围。参考仓库为 DeepSeek Harness；它是只读对照，不是本轮修改目标。本文件与 AI Panel 视觉对齐计划不同：UI 可以正确显示一种事件，但不能据此认定对应的 Runtime 能力已经实现。

> 历史交接基线：阶段 1–5（含 3B）的 53 文件已合入 main（`3e40eef`）；暂停时 6A WIP 保存在 `codex/ai-runtime-stage6a-wip`（`48fd8fd`）。后续实现以本页当前状态及 [交接说明](ai-runtime-handoff.md) 为准，不能从旧 WIP 分支遗漏未提交的累计实现。

## 工作方式与交付边界

- 6A、6B、6C、6D、Stage 7 各自使用新建的独立任务串行交接；Stage 7 在最终 main 目录完成集成和复核，未再派生任务或子代理。
- 阶段实现串行交接，完整迁移上一阶段的已验证代码差异，包括新增文件；不得只复制 Git 提交而遗漏未提交实现。
- 实现期间保留原工作区和用户修改；最终将累计结果安全交付到项目工作区，再执行全量验收。
- 阶段通过不等于总目标完成。以下各项必须以最终累计代码、实际命令结果和运行行为复验。
- 离线合同、确定性 mock、真实 Provider smoke 分别记录。缺少凭据的 live 用例是 SKIP，不是 PASS；不得借用其他项目的密钥。

## 阶段状态

| 阶段 | 范围 | 当前状态 |
| --- | --- | --- |
| 1 | 基线与测试门禁 | macOS 全文 CRLF 模拟、脚本/CI 一致性通过；Windows 原生待验 |
| 2 / 4 | 结构化上下文压缩、Provider 契约 | 最终本地 HTTP/预算/取消/恢复专项通过；外部模型按实际配置分别记录 |
| 3 / 3B | 重试与流式超时、部分流恢复 | 累计专项及全量通过；Stage 7 补 finish 后 usage/断连/取消/idle 边界 |
| 5 | 有界 rolling 工具调度 | 默认4、范围1–16及屏障/预算/取消/故障/恢复累计复验通过 |
| 6A–6D | 问答、Skills、图片、路径补全 | 已接入 main；本地/HTTP/Linux SSH/32浏览器场景通过；Windows 待验 |
| 7 | 集成与最终验收 | 本机交付及证据封存；跨平台总目标未完成 |

阶段 1–3 的任务分别为 `01a0681e-8b9e-7b12-b772-3e6ac792b9bd`、`01a06846-b63d-7511-bc7a-17d5664b10b2`、`01a06865-86a9-7003-9dc4-af95eab100eb`；阶段 4 为 `01a06897-94fa-7302-abde-e9e2e1e2452d`。任务标识仅用于检索交付记录，不代替测试证据。

## 必须验证的行为

### 1. 基线与门禁

- [x] 全文 golden LF 与显式 CRLF 模拟通过，`.gitattributes` 固定 fixture 为 LF。
- [ ] 最终累计代码在原生 Windows CRLF checkout、MSVC 编译/运行和 junction/reparse 场景通过（未运行）。
- [x] package scripts 与 CI 引用一致，无悬空 Runtime / Provider 门禁。
- [x] 保留用户已有改动；交接后的代码及新增文件完整，无临时脚本、日志或凭据混入产品代码。

### 2、4. 压缩与语义连续性

- [x] 保留当前目标、仍有效的用户约束、决策及理由、已完成/未完成工作、文件与命令、阻塞项和下一步。
- [x] 上一份已提交 checkpoint 与新增原始对话共同参与摘要；较早约束、长消息尾部以及后续撤销/覆盖均有测试。
- [x] 超过 100 KiB 的普通待压缩对话不会因为固定小尺寸分块上限而必定放弃语义摘要。
- [x] 模型输入、输出、尝试次数及耗时有明确边界；预算不足或分段失败不得提交已知遗漏原上下文的 checkpoint。
- [x] 工具大输出受控裁剪，并保留哈希、引用和可验证的完整证据；连续压缩不递归嵌套旧摘要产物。
- [x] 只在安全的完整 Turn 边界替换；压缩后重新计算整个请求预算。
- [x] 摘要请求/响应与降级原因有可恢复的 provenance；append-only 日志和 generation 更新保持原子性。
- [x] 覆盖空/非法摘要、预算不足、失败、取消、artifact 写入后取消、连续压缩和重启恢复。

### 3. 请求可靠性

- [x] 重试遵循 Provider 可配置策略、指数退避、jitter、Retry-After 秒数/日期/毫秒提示及上限；配置和旧数据迁移完整，等待可以取消。
- [x] 连接/响应头、首字节和流空闲分别受控；持续有输出的流不受固定 120 秒总时长误杀。
- [x] 输出提交前可以重试；已提交部分内容后的中断不能重放成重复文本、工具调用或副作用。
- [x] 失败持久化尝试次数、累计等待、HTTP/code 和中断状态；前端投影与恢复一致。
- [x] 取消与就绪 chunk / response 竞态优先处理取消。
- [x] 最终累计复验 Harness partial-stream 与空响应恢复。阶段 3B 已支持同 Session、同 step/series 有界恢复，失败 attempt 只保留 chunk/failure 审计，成功消息与工具在完成后提交；Stage 7 已在 main 累计复验，并扩展完整 finish 后传输中断的 text/tool 两类。

### 4. Provider 契约

- [x] TypeScript 与 Rust 使用同一显式能力契约；profile 优先于 hostname，兼容代理与旧配置迁移。
- [x] 区分接收 reasoning、用户可切换 thinking、历史 reasoning 保留及其必要请求字段。
- [x] 覆盖 Qwen、GLM、DeepSeek、MiniMax、Kimi 及通用兼容协议的请求、流和历史回放差异。
- [x] MiniMax 原始 reasoning details 无损回放；GLM / Qwen 的保留开关按实际支持范围发送。
- [x] 工具、并行工具参数、usage、schema、上下文及输出预算与契约一致；不支持的参数在发请求前处理。
- [x] 同时有共享 fixture 和实际 HTTP mock 合同；测试不能只证明 JSON 与自身一致。
- [x] Provider smoke / CI 入口完整，真实调用结果与条件跳过分别列出。

### 5. 并行工具调度

- [x] 用有界 rolling pool 替代整组无上限 join_all；并发配置有默认值和有效范围。
- [x] 并发完成不打乱模型顺序的持久化结果；读组与写操作、审批、编排、Session 工具之间保持屏障。
- [x] 启动前重新核对动态能力/审批条件，不能使用过期的 lookahead 准备结果绕过权限。
- [x] 子 Agent 工具预算覆盖已提交和已保留的调用，不能在仅剩一个额度时启动整组调用。
- [x] 取消或内部错误停止补充新任务，收尾已启动调用；未启动调用与已接受调用的事件配对/跳过状态可恢复且明确。
- [x] 用可控同步点验证上限、反序完成、补位、屏障、预算、取消、失败和恢复，不靠长时间 sleep 掩盖竞态。

### 6. Harness 能力补齐

- [x] `ask_user_question`：真实模型工具、结构化问题/答案、UI 响应、取消与重启恢复；子 Agent 限制明确，不等同于工具审批授权。
- [x] Skills：真实目录注入、刷新/清空语义、模型调用与用户 slash 调用、可见性标志、完整指令及 provenance；加载路径受工作范围限制。
- [x] 图片附件：受限类型与大小验证、规范化、不可变持久化引用、哈希校验、原子批量提交、草稿/发送/恢复 UI、Provider vision 能力路由；不将任意 URL 或路径当成可信附件。
  - 本地 HTTP 实际解码像素/不可变引用/重启验证通过；Qwen 外部视觉调用未运行，不宣称其 live 验证通过。
- [x] `@file`：按工具目标命名空间补全路径，支持空格与目录导航、限制索引规模及符号链接逃逸；补全不自动读取文件内容，不误识别邮箱。
- [x] 每项能力都有端到端调用链及异常测试，不能以新增事件枚举或展示组件代替实现。

### 7. 最终集成与证据

- [x] 累计实现已安全交付到项目工作区，上述本机可执行行为在最终累计状态上复验；Windows 未验证项保持未勾选。
- [x] 全量前端测试、生产构建、Rust 全量测试、格式、Clippy 和差异检查通过。
- [x] AI Phase 3–6、Agent Runtime、脚本测试、AI Panel 视觉回归和性能基准均按仓库当前入口执行并保存结果。
- [x] 视觉基线更新必须逐场景、有理由；更新后完整重跑，不能用批量重录掩盖回归。
- [x] 对齐计划、Runtime 文档、脚本和本清单状态一致；剩余限制、SKIP 和未支持能力明确列出。
- [ ] 所有必需平台证据齐备后才可判定总目标完成；本轮不操作 Goal，Windows 缺口仍在。

## 既有阶段证据（不是最终累计验收）

- 阶段 1：前端 1384 项通过；Rust lib 460 项通过、18 ignored；构建、格式及差异检查通过。
- 阶段 2：前端 1384 项通过；Rust lib 464 项通过、18 ignored；压缩专项 8 项通过。模型语义摘要不属于该阶段已验证结果。
- 阶段 3：前端 1385 项通过；Rust lib 478 项通过、18 ignored；构建、格式、差异检查和 Clippy 通过。
- 阶段 4：前端 1397 项通过，专项 51 项通过；Rust lib 490 项通过、20 ignored；阶段 1–3 门禁、构建、格式、差异检查、Clippy 通过。8 项 live smoke 因未配置项目测试凭据而 SKIP。详见该阶段交付的 `ai-runtime-stage4-validation.md` 和 `ai-runtime-stage4.md`。
- 阶段 3B：前端 1421 项通过，专项 57 项通过；Rust lib 505 项通过、20 ignored；保留阶段 3/4、3B 专项、构建、格式、差异检查、Clippy 通过。真实本地 HTTP 覆盖 partial text/reasoning/tool args → transport/503 → success；Provider 策略持久化、子 Agent 继承、摘要成本与取消边界、投影/replay 和写工具不重执行已验证。未执行付费 live。权威工作树为 `C:/Users/zhengbiwen/.codex/worktrees/c8a3/ShellSpan`，详见 `ai-runtime-stage3b-validation.md`。这是当时未交付到主目录的历史记录；现状以本页顶部和 Stage 7 报告为准。

历史 Windows 阶段使用 `1.95.0-x86_64-pc-windows-msvc` 工具链；当时 Windows 主机默认 GNU 与 Perl/OpenSSL 的兼容问题应与产品代码失败分开记录。这不是当前 Stage 7 macOS 环境说明，也不是最终累计 Windows 通过证据。
