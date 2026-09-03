# AI Runtime 跨设备交接（2026-09-04）

> 用户要求及时停止开发，合并已有成果到 main，后续换设备继续。阶段 6A 已停止，阶段 6B 只读设计已结束；不得把本次交接视为原完整 Goal 验收通过。

## 1. 哪些代码可以继续使用

| 保存位置 | 内容 | 验收状态 |
| --- | --- | --- |
| main，`3e40eefa49ea6a5c56ce5201dbec298687918d1f` | 阶段 1–5，包含补充阶段 3B；53 个累计产品/文档文件 | 已验收的阶段 5 冻结内容，迁移前后全部 SHA-256 一致 |
| `codex/ai-runtime-stage6a-wip`，`48fd8fda6abc37e05497bd74209c76fe1931bf43` | 结构化问答未完成实现；相对上述 main 基线 34 个文件变化（29 修改、5 新增） | WIP，不可直接当作已完成功能合入 main |
| main 的本交接文档及 [6B 设计](ai-runtime-stage6b-design.md) | 后续范围、接口、异常场景、验收要求 | 设计与交接，不是测试通过证据 |

WIP 提交以 `3e40eef` 为父提交，完整保存 71 个累计产品/文档文件，没有遗漏新增文件。清单与文件哈希见 [交接清单](ai-runtime-handoff-inventory.json)。原 ac59 工作树未删除、未覆盖；两个编译生成的 schema 变化没有进入 WIP 提交。

不交付为产品：`.phase*-evidence/`、`node_modules/`、`dist/`、Rust target、临时迁移脚本、测试日志、凭据。原工作区仅有本轮创建的未跟踪 remediation plan；覆盖为累计版本前已备份到本机 Git 目录中的 `codex-handoff-20260904/original-main-remediation-plan.md`。其他用户文件未覆盖。

## 2. 另一台设备如何接续

若分支已推送到 origin，先在已有仓库执行：

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git worktree add ../ShellSpan-6a -b codex/continue-questions origin/codex/ai-runtime-stage6a-wip
```

然后在新工作树中合并最新 main 的交接文档，检查差异并继续 6A：

```sh
git merge --no-edit origin/main
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
```

若尚未推送，先将交接 bundle 复制到另一台设备。该增量 bundle 依赖现有 origin/main 已有的 `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`，先 fetch origin 获取基线，再执行（将 `PATH_TO_BUNDLE` 替换为实际文件路径）：

```sh
git fetch origin
git bundle verify PATH_TO_BUNDLE
git fetch PATH_TO_BUNDLE refs/heads/main:refs/remotes/handoff/main refs/heads/codex/ai-runtime-stage6a-wip:refs/remotes/handoff/ai-runtime-stage6a-wip
git switch main
git merge --ff-only handoff/main
git worktree add ../ShellSpan-6a -b codex/continue-questions handoff/ai-runtime-stage6a-wip
```

此时新工作树从 `handoff/main` 合并交接文档。不要只复制旧机器的 worktree 路径。bundle 的实际位置、是否已推送及最终 main 提交以交接消息为准。分支名已存在或本地有修改时先核对，不能 reset --hard 或覆盖用户修改。

Windows Rust 验证使用命令级 `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc`，不要改全局默认工具链。旧机器曾复用其他 worktree 的 target，仅是构建缓存，新设备不依赖它。默认 GNU 工具链与本机 Perl/OpenSSL 的问题不能误报为产品失败。

参考 Harness 提交：`49a606bc5b5934603f22a26957a07dc799ab0291`。旧设备位置 `D:/Developer/deepseek-harness` 只是定位信息；新设备另行检出参考仓库并保持只读。

## 3. main 已交付能力与证据

- 基线：prompt golden 换行一致、修正悬空测试脚本、CI 门禁。
- 上下文压缩：结构化 checkpoint、模型语义摘要、完整 Turn 边界、长消息与撤销约束、输入/输出/重试/耗时预算、可恢复 provenance 和失败不提交。
- 请求可靠性：Provider 可配置 RetryPolicy、指数退避与 jitter、Retry-After、连接/首字节/idle 超时；同 Session 部分流失败有界恢复，失败 attempt 不重复生成最终正文或工具副作用。
- Provider：共享 TS/Rust 能力契约、显式 profile、代理与旧配置迁移、reasoning/history 适配和 HTTP mock 合同。
- 调度：默认 4、范围 1–16 的有界 rolling pool，结果按模型顺序提交；写入/审批/编排/Session 工具屏障、动态重新授权、预算保留、取消收尾和恢复。

阶段 5 冻结验收：前端 **1421 项通过**；Rust lib **522 项通过、20 ignored**；17 个 scheduler 用例最终连续三次通过；build、29 项 scripts、fmt、Clippy、stage3/4/3B/5 门禁通过。详细命令与范围见 [阶段 5 验收](ai-runtime-stage5-validation.md)、[阶段 4 验收](ai-runtime-stage4-validation.md)、[阶段 3B 验收](ai-runtime-stage3b-validation.md)。这些是对应冻结状态的阶段证据，不是全部后续能力或新设备的最终验收。

本轮未发起付费/live 请求。缺少本项目凭据的 live 测试是 SKIP/ignored，不是 PASS；不得借用其他项目凭据。旧 AI Panel 文档中的历史 live 记录不能代替本轮验证。

本次合入 main 后补做的检查：`pnpm exec tsc --noEmit` 通过；MSVC 1.95.0 的 `cargo fmt --all -- --check` 通过；`pnpm test:ai:stage3b:frontend` 57 项/4 文件通过；Git staged diff 检查通过。遵循及时停止要求，没有重跑完整阶段 7、视觉、性能或 live 验收，也没有继续修复 WIP。

## 4. 优先继续 6A：结构化用户问答

停止时已写入：严格问题/答案类型、独立 question 事件、工具目录与屏障、live ownership 检查、答案 IPC、恢复入口及前端卡片/两套投影/composer 的初稿。

新文件：

- `src-tauri/src/agent_runtime/user_questions.rs`
- `src/components/ai/workspace/ai-question-panel.tsx`
- `src/lib/ai/question-projection.ts`
- `src/stores/agentQuestionStore.ts`
- `src/types/agent-question.ts`

停止前 `pnpm install --frozen-lockfile`、最新 `cargo check --lib --locked` 通过。**TypeScript 编译失败**：现有 Field 模块没有 `FieldSet` / `FieldLegend` 导出，两处测试 adapter 缺少 `answerQuestion`。未运行行为测试、全量回归、build、fmt、Clippy 或 live；没有 stage6a 门禁及正式验收报告。

必须先修复编译，再证明下面的完整链路：

```text
原 AssistantMessage 的 ask_user_question
→ 排空前序工具 → 持久化问题 → 原 Session 等待
→ 提交答案 → 持久化一次答案/ToolResult
→ 执行原 Step 剩余调用 → StepEnd → 原 Turn 下一模型请求
```

验收不能停在“卡片可见”或“答案已保存”。优先验证：

1. Runtime A 提问落盘，销毁后 Runtime B 经实际答案入口 attach 原 Session、取现有凭据、继续请求；Session/Turn/call ID 正确，无额外用户消息或重复回答。
2. 只有一个问题的最小响应，以及 `read → question → write → question`；原 Step 完成后只推进一次。曾发现新入口可能重复处理已回答问题的风险；底层 pipeline 有 StepEnd，但新入口/scope 的实际推进尚未端到端证明。
3. ToolCall、question/requested、question/answered、ToolResult、StepEnd 各完整 JSONL 行前缀重启；append_batch 不是断电原子事务。已提交答案补齐结果，不重问；后续未执行工具不丢失，已执行工具不重放。
4. 取消、答案提交、等待状态发布、driver lease 释放的可控竞态；无丢失唤醒、双结果、取消后 admission 或模型请求。等待不受审批 TTL 终结，关闭面板/断线不等于取消。
5. 身份包含 session/turn/step/request/call/questionRequest；clientOperationId 幂等。相同原始提交重试成功，不同答案拒绝，跨 Session、陈旧与取消后提交拒绝。
6. 脱敏与幂等：原始提交指纹与 committed 脱敏答案分离的修正尚未测试。相同敏感答案重试不能变成 conflict；不同原始答案不能因都脱敏成 `[REDACTED]` 被混淆；不另存明文。问题/标签脱敏冲突以及写入失败不能留下孤立 pending 或错误 Waiting。
7. 1–3 问，选项可省略或 2–7 个；未知字段、重复 ID/label、多字节超限、空白答案拒绝。单选 custom 覆盖 selected，多选可并存；推荐项不自动选中/提交。
8. 根身份由当前 live registry ownership 判定，不以历史 subagent lineage 替代；子 Agent 执行入口拒绝。回答绝非权限批准，后续写操作仍走原审批。
9. 问答卡在折叠过程之外可操作，普通草稿保留；重连、切换 Session、失败重试、已回答只读、两套 projection 和中英文一致。修复组件时按仓库 shadcn 技能使用实际存在的组件，不为 CLI 的 SDK/zod 故障升级依赖。

完成后新增 `test:ai:stage6a`、实施/验收文档、累计文件/hash 清单，并回归 stage3/4/3B/5、全量前端、build/scripts、Rust lib/fmt/Clippy/diff。未经验收不得合入 main。

## 5. 后续独立阶段

### 6B Skills

[完整设计报告](ai-runtime-stage6b-design.md) 已保存；没有实现。需要真实目录发现、完整替换/空目录退役、模型 `skill` 工具、仅扫描已 claim 直接用户消息的 `/name`、model/user invocation 四组合、完整指令/provenance 和受限 local/remote 目标读取。

关键风险：pre-step hook 先于 claim；`ensure_model_context` 只去重一次；native 结果超过 8 KiB 变 artifact 摘要，不可用于完整技能正文；读取失败不能假空；脱敏改变正文时不能保留原 hash 冒充完整载入。目录、加载和 slash 都必须有生产消费者与真实请求/恢复测试。

### 6C 图片附件

- 明确选择 PNG/JPEG/WebP/GIF，验证实际 MIME、字节/像素/解压上限，规范化颜色和 metadata。
- 不可变内容寻址 blob、完整性校验、整批导入成功后才提交 Inbox；不在事件中保存 Base64 或任意可信路径。
- 草稿添加/预览/删除/发送/恢复链路；失败或取消不得把草稿显示成已发送。
- 共享 model-specific vision 能力与真正图片请求内容块，预算明确；不支持时拒绝，不静默丢图。能力依据当时官方文档验证。
- 不提供任意 renderer 路径读取或 URL 抓取权限；覆盖坏格式、篡改、部分导入、取消和不支持 Provider。
- 参考 Harness `packages/attachment/attachment/README.md`。

### 6D @file

- 只补全路径，不自动读取内容或变成附件。
- 冻结的本地/远端工具目标命名空间；开头/空白后的 @，不匹配邮箱；支持空格引用和目录斜杠继续导航。
- 有界、可取消目录索引；防 symlink/junction/路径逃逸，不扫无关根目录。
- Rust IPC→服务→composer 真链路，旧异步结果丢弃，键盘/IME/无障碍/空态/错误明确。
- 参考 Harness `packages/context/file-reference/README.md`。

### 7 最终累计验收

各阶段在独立任务窗口实现并冻结交接，包含未跟踪产品文件。最后安全整合到 main，再逐项复核 [原范围清单](ai-runtime-harness-remediation-plan.md)，不能缩减为现有通过的测试。

至少执行：`pnpm test:ai:phase3`、`phase4`、`phase5`（含 visual）、`phase6`，`pnpm test:agent:runtime`、`pnpm test:scripts`、`pnpm test`、`pnpm build`、`pnpm benchmark:ai-panel`、所有新增 stage 门禁、Rust fmt、Clippy `--all-targets --all-features -- -D warnings`、`cargo test --all-features --no-fail-fast`、`git diff --check`。

视觉基线仅允许逐场景、有理由更新，更新后完整重跑；不能批量重录掩盖回归。真实 Provider smoke 缺配置则明确 SKIP。只有所有必需行为、文档、命令与运行证据完成后才可将原 Goal 标为 complete；本次按用户要求停止，不代表该条件已满足。
