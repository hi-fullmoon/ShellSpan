# AI Runtime 当前交接 — Stage 7（2026-09-04）

## 当前权威工作区

累计 Stage 1–6D 及最终修复已交付到 **/Users/zhengbiwen/Developer/ShellSpan**。
HEAD 仍为 `31ce4343b9a834503c43db1b04b81fe0128e4ea0`；没有提交、暂存、推送或外部流水线执行。
后续只以此主目录和 [Stage 7 验收](ai-runtime-stage7-validation.md)、
[最终文件清单](ai-runtime-stage7-handoff/inventory.json) 为准，不要从旧 WIP 或隔离树覆盖主目录。

macOS、本地实际 HTTP、隔离 Linux SSH 和已配置 Provider live 的结果见验收报告。
**Windows 原生编译/运行及 junction/reparse 控制竞态尚未验收，总目标不能标为全部完成。**
CRLF 仿真不是 Windows 原生通过；缺配置的外部 Provider 仍为 SKIP。

## 安全集成与用户改动

冻结 6D 源为 `/Users/zhengbiwen/.codex/worktrees/6461/ShellSpan`，与主目录 HEAD 相同。
接收前核验清单 `ae5faca192b2fe6471f2b33dd6221e2b60208f209d3ee4bdb0c27e3c4dbce633`、
两份补丁及 160 个累计源文件；先在 `7f92` 隔离树重建，再检查主目录 HEAD、未提交状态、index 和同名文件冲突。
对主目录应用通过 check 的 stage patch，另复制全部 **68** 个新增产品和 **14** 份 6A–6D 元数据。
接收后 160/160 源文件和全部元数据逐一匹配，没有迁移冲突或遗漏。

用户唯一既有改动是 `src/components/ui/input-group.tsx` 删除 focus-visible border-ring 类，
整个文件始终保持 SHA-256：
`b88fb8fb45dc6f988a553d31174915c34ad6fc1e2aa327548b8cdacacc1d5418`。
原 index 字节 SHA-256：
`7deee642128e942abef40bb5a6e858b84a487a553a3cfe25ea6c5d9248cabe16`。
最终清单再次核对它们。main 的跨 series 按 Turn 聚合、request/start 与 prompt snapshots 去重、
pnpm lock/workspace 修复全部保留。源 6D 与 Harness 没有修改；只复用了明确授权的 ad7b Rust target 缓存。

## 当前实现与最终修复

- 结构化语义 checkpoint、预算/失败/取消/provenance、安全完整 Turn 边界。
- Provider 共享 TS/Rust 契约、可配置 retry、同 Session/step/series 的 partial/empty 恢复。
- 默认 4、范围 1–16 的 rolling scheduler；顺序提交、屏障、动态授权、子 Agent 预算和恢复。
- 完整结构化问答，真实答案入口和重启后原 Turn/Step 的后续工具/模型推进。
- 完整 Skills 目录与四种调用策略，直接用户 slash、模型工具、完整正文/provenance、受限本地/远端读取。
- 有界图片规范化、immutable blobs、原子批次、持久草稿、实际 HTTP 图片块和重启/压缩保留。
  vision 仅允许 Qwen `qwen3-vl-plus` / `qwen3-vl-flash`；128000 是保守应用预算。
- @file 只插普通路径文本；冻结项目根、目录身份、单层有界查询、取消、IME 与 SSH。
- Stage 7 修复 Chat 流在 finish_reason 后提前结束、丢失独立 usage 帧；保持干净 EOF 兼容，
  取消/idle/异常 EOF 仍受原合同约束，失败 attempt 不提交正文或工具。
- Stage 7 修复 completion 的旧 dismissed key 在改写后返回同一文本时抑制新查询；保留原 6D 偶发超时记录，
  不把新发现的独立问题冒称为旧问题已确认根因。
- CI 补齐累计 gates、8 个 include! Rust 文件格式检查、真实浏览器桥接及隔离 SSH 入口。
  Phase 5 只更新一个确有原因的分页截图，保留前后证据。
- Stage 7 阻止晚返回的初始化历史查询覆盖新草稿/图片归属/已选项目；显式新会话会撤销旧自动订阅。
  5 个可控 controller 回归和实际 Rust 历史回复屏障覆盖该竞态，不靠延长菜单点击等待。
- 性能入口增加普通测试 preflight 和有效样本检查，防止实验 benchmark 报错但 exit 0 的假通过；
  保留原 5,000 消息（7,500 含过程节点）/20 次重投影工作量。

## 如何继续或迁移

主目录现有未提交修改就是交付物；不要 reset/restore/add 整个工作区。
最终清单区分累计产品、相对 HEAD 的修改、新增产品、历史交接元数据和用户保留项，并提供 SHA-256。
若迁移到另一设备：在匹配基线上先 check 对应 tracked patch，复制**全部**新增产品及元数据，
再校验清单；tracked patch 不包含新增文件。用户 InputGroup 改动单独保存，不能当成 AI 的修改覆盖别人的文件。

[最终验收报告](ai-runtime-stage7-validation.md) 给出 Windows 前置条件、准确 gate 命令与仍未完成的原生场景。
真实 live 只加载本项目已有 `.env.local`；不要打印/复制密钥，也不要借用其他项目。
最终变化和测试证据封存后停止修改，等待总协调复核。

## 历史来源（不是当前状态）

- Stage 1–5 曾交付于 `3e40eef`；早期 6A WIP 为 `48fd8fd`，已被后续累计实现取代。
- [Stage 4](ai-runtime-stage4-validation.md)、[3B](ai-runtime-stage3b-validation.md)、[5](ai-runtime-stage5-validation.md)：
  历史 Windows 阶段测试，不能代替新增 6B–6D 的 Windows 原生验收。
- [6A](ai-runtime-stage6a-validation.md)、[6B](ai-runtime-stage6b-validation.md)、
  [6C](ai-runtime-stage6c-validation.md)、[6D](ai-runtime-stage6d-validation.md)：
  原隔离树证据与限制保持原文，其“未合入 main/后续待做”仅指对应阶段当时的状态。
- 6A–6D 冻结目录、补丁、inventory/reconstruction 均按原字节保留；
  [早期交接清单](ai-runtime-handoff-inventory.json) 仅用于历史溯源。
- 原 AI Panel Phase 0–6 证据见 [对齐计划](ai-panel-deepseek-harness-alignment-plan.md)。
