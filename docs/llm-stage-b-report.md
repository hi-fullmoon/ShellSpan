# LLM 阶段 B：统一模型能力

状态：阶段 B 实现完成，交协调任务验收和集成。未启动 C–E。

## 基线与提交

- 隔离目录：`C:\Users\zhengbiwen\.codex\worktrees\69af\ShellSpan`。
- 分支：`codex/llm-stage-b`。
- 源目录：`D:\Developer\ShellSpan`，只读；没有修改、提交或推送源目录。
- 导入前双方实际 HEAD：`df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`。交接中的 `fc619f5` 是阶段 A 的历史基线，协调者确认使用实际 HEAD。
- 完整导入快照：`383047edd1bc8838f2792ecbc08efe04825a1ec8`。
- 阶段 B 代码提交：`c060f31b0195dbb1b1f6e29053e9409dbe05d77f`。
- 本报告单独提交，其父提交为上述代码提交。协调者应导出 `383047edd1bc8838f2792ecbc08efe04825a1ec8..HEAD`，包含代码和报告，排除导入快照。

先核对不同目录、相同 HEAD、干净目标，再使用源目录 `git diff HEAD --binary --output=<临时补丁>` 和目标 `git apply` 导入 tracked 改动。另复制源目录 `git ls-files --others --exclude-standard` 的源码/报告，包括阶段 A 的完整 `llm/`、`model_tools.rs` 和报告；没有复制 `.env`、密钥、依赖目录、target 或缓存。既有图片、会话模型选择和阶段 A 实现均在快照内。`docs/llm-implementation-progress.md` 没有阶段差异。

## 实现与证据

| 设计要求 | 文件与实际消费者 |
| --- | --- |
| 协议、预设、精确模型分离 | `protocol/llm/catalog.json`：8 个预设身份、54 个精确模型；协议兼容通过有类型的 `Compat.protocol` 与编码枚举校验。没有模型前缀匹配、大小写归一化、名称容量暗示。旧域名推断只保留在 Rust 旧配置转换入口 `legacy_profile`；端点规范化也由配置解析完成，三个协议发送解析后的端点。 |
| 同源校验 | `catalog.schema.json`、`scripts/check-llm-catalog.mjs` 校验目录及负例；`llm/catalog.rs` 使用 `deny_unknown_fields`、枚举和语义校验，额外检查输出不超过上下文、重复推理 ID、视觉预算和协议兼容约束。 |
| 统一 DTO | `ResolvedModel` 提供 route/provider 身份、原样 modelId、context/output、source、capacityPolicy、工具/文本/图片三态、按顺序的推理 ID/名称、视觉预算、强类型 compat。端点仅供后端使用，不序列化；DTO 不含密钥。 |
| 用户声明 | `AiProviderConfig.modelDefinition` 是完整显式声明，可替换精确内置条目，也可声明目录外模型。不存在容量/工具/图片的隐式默认授予。只要求容量为正、可被 JSON 精确表示，且输出不超过上下文；允许 `32768/16384`，也测试了 4096 和 4M 上下文。 |
| 实际协议消费 | `llm/adapters/{chat_completions,responses,ollama}` 消费解析后的 compat、推理、输出上限和端点；`transport/stream.rs` 在连接前拒绝非明确支持的工具/文本/图片请求。兼容 Chat 的 strict schema 开关有实际编码。MiniMax 累计流、DeepSeek 推理回放、Qwen instruct、GLM retention、Kimi、Responses、Ollama 的既有 fixture 保留。 |
| 主预算、预检和压缩 | `budget.rs` 返回可失败的解析预算，所有 driver/runtime/compaction 调用点传播错误。输出预留与实际 wire 上限一致，不再另行裁成四分之一。压缩请求及压缩替换预算读取同一模型事实，后者携带该模型的每图预留量。压缩 provenance 记录无密钥解析结果。 |
| 图片 | `images.rs::vision_route` 读取 resolver；`vision-contract.json` 只保留全局安全限额。不可变 ImageRef、解码、像素、文件、取消、数量及字节检查保持。含图片历史换到文本模型仍拒绝。图像 token 数是准入估算；服务端 usage 类型与累计逻辑不变。 |
| 前端 | 删除旧 `provider-contract.json`；`provider-contract.ts` 通过 `ai_resolve_model` 加载缓存，按完整配置身份分键，不解析域名/前缀/容量提示。`ai-reasoning.ts`、视觉准入、设置、会话模型选择器消费后端 DTO。loading/error 不借用上一模型事实；推理显示名称来自 DTO。 |
| 设置与自定义连接 | `provider-setup-dialog.tsx` 复用现有 shadcn Field/Input/Combobox/Button，展示加载、错误、来源、容量，提供声明/取消覆盖和图片预算编辑。保存前用包含用户推理选择的配置调用后端校验，密钥不送入能力 IPC；校验失败不写凭据或设置。修改连接身份/模型时清除旧声明。 |
| v4 恢复 | 声明随现有 `ai.providers` 保存。`config.rs::restore_model_definition` 与 `ModelRegistry::restore_config` 只按 providerId、kind、baseUrl、原样 modelId，并核对 profile，读取当前设置补齐；不创建第二个声明存储。子任务创建直接继承父配置与适配器；冷恢复从相同设置入口恢复。问答日志读取只验证描述符结构，续跑前才恢复声明并完整验证。 |
| 前后端契约 | `protocol/llm/fixtures/resolved-models.json` 是测试快照，Rust 测试逐条比较实际 resolver 序列化结果；前端测试只模拟这些后端 DTO，生产代码不导入目录或 fixture。 |

内置容量延续现有 ShellSpan 应用预算，并标注来源；它们不宣称是当前厂商公布的最大容量。模型发现仍只是候选列表，未列入目录的发现项需要用户声明。没有给测试字符串增加生产例外；原合成模型/容量提示测试改成显式 fixture 配置。

## 实际验证

Windows Rust 命令统一使用 MSVC 1.95.0，manifest 始终指向本 worktree，仅复用经授权的构建缓存：

```powershell
$env:CARGO_TARGET_DIR='D:/Developer/ShellSpan/src-tauri/target'
cargo +1.95.0-x86_64-pc-windows-msvc check --manifest-path src-tauri/Cargo.toml --lib --locked
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked <filter> -- --test-threads=1
```

下表列出上述测试命令实际使用的 filter；没有将失败/中止运行计为通过。

| filter / 额外参数 | 最终结果 |
| --- | --- |
| `llm::` | 32 passed，9 ignored（7 个新增目录/DTO/容量/拒绝/恢复测试，25 个既有协议测试） |
| `ai::tests` | 21 passed |
| `agent_runtime::budget::` | 2 passed |
| `agent_runtime::compaction::` | 17 passed |
| `agent_runtime::provider::` | 2 passed |
| `agent_runtime::event::` | 7 passed，含 v4 跨语言 fixture |
| `agent_runtime::driver::` | 3 passed |
| `agent_runtime::registry::` | 2 passed |
| `agent_runtime::subagent::` | 1 passed |
| `agent_runtime::runtime::tests::`，尾部另加 `--skip image_tests --skip image_bridge_tests --skip file_reference_tests` | 99 passed，1 ignored |
| `agent_runtime::runtime::tests::image` | 16 passed，2 ignored |
| `agent_runtime::runtime::tests::file_reference_tests` | 6 passed |
| `image_compaction_keeps_pixels` | 1 passed；在压缩替换预算接入模型每图预留后额外复核 |
| `cargo check --lib --locked` | 通过；仅基线已有 `images.rs` 未使用 `File` 导入警告 |

协议 fixture 使用本机 HTTP 服务器实际收发 SSE/NDJSON，包含三种协议的 `context=32768/output=16384` 声明覆盖、原样 model ID、真实 usage=3 与输出预算=16384 分离、兼容推理、尾部 usage、取消和重试。9 个外部模型服务测试没有配置凭据，保持原 ignored 条件；没有声称外部 live 验证通过。

前端及静态检查实际命令：

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec vitest run src/lib/__tests__/provider-contract.test.ts src/lib/__tests__/ai-reasoning.test.ts src/lib/__tests__/model-resolution.test.tsx src/stores/__tests__/aiSettingsStore.test.ts src/components/ai/__tests__/provider-setup-dialog.test.tsx src/components/ai/__tests__/image-draft.test.tsx src/components/ai/__tests__/ai-workspace-controller.test.tsx src/test/fixtures/__tests__/agent-session-v4.test.ts --maxWorkers=1
pnpm test:ai:stage4:frontend
pnpm check:llm:catalog
node scripts/check-rust-includes.mjs
git diff --cached --check
```

- 依赖安装通过，锁文件不变。
- TypeScript 通过。
- 8 文件前端组合：119 passed；后续相关 2 文件分组：28 passed；最终 `test:ai:stage4:frontend` 的 5 文件：62 passed。各次运行有重叠，不能相加。此前报告中的 121 没有对应的实际运行证据，已按成功命令输出更正，未为修正计数重复运行测试。
- 缓存测试覆盖旧连接晚到、切换即清空、同键并发去重、错误重试、身份不匹配、v5-only 推理 ID 拒绝、精确恢复。设置测试覆盖高输出声明保存和不支持推理在写入前拒绝。
- schema：54 个模型通过，4 个无效目录负例拒绝；Rust 另测跨字段无效容量、未知参数和不兼容协议。
- Rust include 格式检查：11 文件通过；LLM 模块使用 `rustfmt +1.95.0-x86_64-pc-windows-msvc --edition 2021 src-tauri/src/llm/mod.rs` 格式化。
- `package.json` 已接入 `check:llm:catalog`；stage4 frontend 包含 model-resolution，stage4 Rust 使用 `llm::` 包含 catalog_tests，stage4 总入口先跑 schema。

过程中的失败均保留为调试事实：早期 Result 接线导致临时编译错误；旧 synthetic fixture 缺少声明、图片 fixture 继承了不匹配的 Ollama compat；问答 v4 读取曾错误依赖完整能力；容量 fixture 需要显式小输出预留。修正后以上相关分组通过。首次 `agent_runtime::` 整组在旧图片 fixture 失败后等待，已终止，不能算整组通过；改用表中相关分组。前端曾有 mock 提升、异步等待、旧“静默丢弃推理”断言、ES lib 不支持 `.at()` 和 include 格式问题，均已修复。没有移除 pixels、历史恢复、usage、审批或重试断言来获取通过。

shadcn `pnpm dlx shadcn@latest docs ...` 曾遇到本地缓存 zod exports 错误；改用项目已有 `pnpm exec shadcn docs field input combobox alert dropdown-menu` 成功，并读取官方组件文档。未改依赖解决该环境问题。

## 明确的 C 交接与 v4 限制

1. Event 仍为 v4，未添加 `modelDefinition` 事件字段。v4 只有旧连接/模型描述符，**无法保存某次选择的声明版本**。恢复匹配到的是现有 `ai.providers`，不是当时的不可变能力快照。设置被修改/删除后，目录外模型缺声明会明确失败；内置模型原有覆盖是否丢失，v4 本身无法证明。C 必须用 RouteStore、修订与 v5 快照消除这一限制。
2. 自定义模型当前可配置、可运行，活子任务直接继承配置，精确设置仍在时可恢复。C 最终验收必须覆盖自定义模型主任务/冷重启/子任务全链路，以及连接改变、删除和声明修订的行为，不能删除该要求。
3. 目录推理是有序字符串 ID/名称，但旧 `AiReasoningEffort`、前端提交类型与 v4 恢复仍是固定枚举。本阶段明确拒绝 `ultra` 等 v4 无法表示的声明/DTO/持久化选择，不静默过滤或降级。C 必须开放 string selection、明确 wire 编码约束并用 v5 持久化。
4. 本阶段消除了多份事实来源，实际消费者已接入；但没有实现完整 `PreparedModel/PreparedCall`、路由/凭据修订锁定、提交事务或完整请求快照。预检与正式调用仍处于既有配置/Step 生命周期。C 必须把它们固定到同一准备对象，并将有效能力/compat/来源写入最终请求快照。
5. frontend cache 当前按旧完整连接配置分键；C 应替换为 route/model/revision 驱动的加载与失效机制，并改为提交 ModelSelection。现有单连接单模型配置 UI 保持，未抢做多模型连接 UI。
6. ReplayEnvelope 和跨域回放仍属 D；Anthropic 仍属 E。全局图片安全限额和不可变存储继续保留，图片历史降级策略没有引入。

协调任务可导出：

```powershell
git diff --binary --output=<阶段B补丁路径> 383047edd1bc8838f2792ecbc08efe04825a1ec8 HEAD
```

没有推送。源目录集成、阶段验收与后续任务由协调者执行。
