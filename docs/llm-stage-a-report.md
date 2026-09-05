# LLM 阶段 A：协议提取交付报告

状态：阶段 A 实现完成，交协调任务验收与集成；未启动阶段 B–E。

## 基线与提交

- 工作目录：`C:\Users\zhengbiwen\.codex\worktrees\5d95\ShellSpan`
- 隔离分支：`codex/llm-stage-a`
- 源目录：`D:\Developer\ShellSpan`，未修改源文件、提交、重置或推送。
- 导入前双方 HEAD：`fc619f5bc7bb3c6618d86136897ad8525f8d4122`
- 用户修改基线 snapshot：`f5ee96508f1a12f8165c857397a961b2371b15df`
- 阶段 A 代码提交：`da6a06de552fbe8c3747c4c8e958f372bf8edb41`
- 本报告另作文档提交，其父提交为上述代码提交。协调任务应导出 `f5ee96508f1a12f8165c857397a961b2371b15df..HEAD`，包含代码与报告，排除用户基线 snapshot。

导入使用 `git diff --binary --output=... HEAD` 与 `git apply --binary`，没有经 PowerShell 文本管道转写 patch。另复制 `git ls-files --others --exclude-standard` 列出的四个源码/设计文件：两个 LLM 设计/进度文档，以及 `image-error.ts`、`session-settings.ts`。未导入 `.env`、密钥或构建产物。现有图片功能、会话模型切换修改和已跟踪资源均位于基线中。

`docs/llm-implementation-progress.md` 未作为阶段产出修改。阶段 diff 不包含前端实现修改、依赖锁文件修改或自动生成的 Tauri schema 修改。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/llm/types.rs` | 统一请求、消息、内容块、工具 schema/call、增量、响应、usage 类型；保留原 serde 形状 |
| `llm/errors.rs` | 既有错误类型、分类、重试判定、脱敏 |
| `llm/adapter.rs` | `ModelAdapter`、`ModelStreamSink`、工厂接口及 `RequestImageResolver` 小接口；图片解析装饰器 |
| `llm/registry.rs` | 编译期注册并构造三种实际适配器；仅在此处按旧 `AiProviderKind` 选择协议 |
| `llm/config.rs` | 从 `ai.rs` 提取旧配置 DTO、URL 校验/规范化、输出和推理兼容入口，供 B/C 继续迁移 |
| `llm/discovery.rs` | 已有模型列表发现逻辑，不推断模型能力 |
| `llm/usage.rs` | 保留缺失计数、缓存输入扣除与最后有效累计 usage 合并 |
| `llm/transport/http.rs` | HTTP 客户端、禁用重定向、有界响应读取、发现请求错误处理 |
| `llm/transport/stream.rs` | 请求头超时、首字节/空闲 deadline、取消、HTTP 状态与 Retry-After 分类 |
| `llm/transport/sse.rs` / `ndjson.rs` / `limits.rs` | SSE/NDJSON 分帧与 UTF-8、尾帧、4 KiB 错误体/1 MiB 非流响应和帧/16 MiB 总流限制 |
| `llm/adapters/chat_completions/mod.rs` | Chat Completions 请求序列化、SSE 事件与尾部 usage 解析 |
| `llm/adapters/responses/mod.rs` | Responses 请求、原生 reasoning item 回放、SSE 事件与输出转换 |
| `llm/adapters/ollama/mod.rs` | Ollama 请求、NDJSON 事件、thinking/tool/usage 解析 |
| `llm/adapters/common.rs` | Chat/Ollama 共用历史编码、块顺序与工具参数累积/校验、现有兼容选项；不汇集三种流解析器 |
| `agent_runtime/model.rs` | Agent 历史投影、recorded tool call 转换、`ImageStore` 所有权与接口实现，暂时 re-export LLM API |
| `agent_runtime/model_tools.rs` | Agent 自有内置工具定义与 schema，未迁入通用 LLM 层 |
| `agent_runtime/event.rs` | 仅将旧 `AgentRequestToolSchema` 名字别名到同形状的通用 schema，Event 仍是 v4 |
| `ai.rs` | 保留 Tauri 命令、凭据和偏好迁移；原配置类型暂时 re-export |
| `llm/tests.rs` | 原 model 的全部 34 项 fixture/live 测试，wire 测试改为经过实际注册工厂；未弱化断言 |
| `package.json` / `scripts/agent-provider-live-smoke.mjs` | 更新迁移后的测试路径，stage1/2/3 的组合门禁仍包含协议测试 |

图片解码、不可变存储、大小限制继续由现有 `ImageStore` 实现负责。LLM 装饰器通过 `RequestImageResolver` 获取已解析 data URL；Agent 接口实现保留 `vision_route` 检查，包括空图片集合的 `UserImages` 情况。LLM 层不依赖 AgentEntry、审批或 SSH 执行对象。

## 实际验证

所有最终 Rust 验证使用与源目录一致的 MSVC 1.95.0。源目录设置了 rustup directory override，隔离 worktree 不会继承，因此命令显式指定 toolchain。经协调任务授权，仅复用源目录的构建缓存；`--manifest-path` 始终指向本 worktree，Cargo 输出确认编译隔离源码：

```powershell
$env:CARGO_TARGET_DIR='D:\Developer\ShellSpan\src-tauri\target'
cargo +1.95.0-x86_64-pc-windows-msvc check --manifest-path src-tauri/Cargo.toml --lib --locked
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked llm::tests -- --test-threads=1
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked ai::tests -- --test-threads=1
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked agent_runtime:: -- --test-threads=1
```

| 检查 | 最终结果 |
| --- | --- |
| MSVC `cargo check --lib --locked` | 通过；仅基线已有 `images.rs` 未使用 `File` 导入警告 |
| `llm::tests` | 25 通过，0 失败，9 ignored（外部模型服务） |
| `ai::tests` | 21 通过，0 失败 |
| `agent_runtime::` | 243 通过，0 失败，5 ignored（既有 bridge/集成 runner） |
| `pnpm test:agent:runtime` | 8 文件、94 测试通过 |
| `pnpm test:ai:stage4:frontend` | 4 文件、55 测试通过 |
| 下列图片/controller/v4 Vitest 命令 | 3 文件、60 测试通过 |
| 下列 rustfmt 检查 | 通过 |
| `node scripts/check-rust-includes.mjs` | 11 个 include 文件通过 |
| `git diff --cached --check` | 通过 |

```powershell
pnpm exec vitest run src/components/ai/__tests__/image-draft.test.tsx src/components/ai/__tests__/ai-workspace-controller.test.tsx src/test/fixtures/__tests__/agent-session-v4.test.ts --maxWorkers=1
rustfmt --check --edition 2021 src-tauri/src/llm/mod.rs src-tauri/src/agent_runtime/model.rs src-tauri/src/agent_runtime/model_tools.rs src-tauri/src/ai.rs
```

Rust 验证覆盖 provider 容量/兼容、压缩、Runtime/driver、图片、恢复、工具审批与重试、`session_settings_switch_at_next_request_and_survive_restart`、跨语言 v4 fixture round-trip。协议用本机 TCP HTTP 服务真实发送和接收请求，覆盖逐块 SSE、尾部 usage、取消、timeout、Retry-After、请求 schema 和厂商兼容；这不等同于外部厂商 live smoke。

构建与依赖准备中出现过的失败：

- 默认 `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked` 选择了 GNU toolchain，vendored OpenSSL 被 Windows Strawberry Perl 路径语义阻塞，未进入项目检查，不能算通过。
- 临时使用 `OPENSSL_NO_VENDOR=1`、`OPENSSL_DIR=D:\Programs\Strawberry\c` 的 GNU 尝试在协调任务查明 MSVC override 后主动停止，未作验证依据。最终 MSVC 命令不使用这些覆盖。
- `pnpm install --offline --frozen-lockfile` 因离线缓存缺少 zod tarball 失败；随后 `pnpm install --frozen-lockfile` 成功，锁文件未改。
- 提取中的临时 Rust 符号/可见性接线错误均已修复；以上最终检查未残留阶段 A 编译错误。

## 保留边界与 B 阶段交接

1. Event 保持 v4，旧请求字段、序列化与重试语义保持。未实现路由存储、PreparedModel/Call、v5、ReplayEnvelope 或 Anthropic。
2. 能力解析仍使用 `agent_runtime/provider.rs` 与现有视觉契约；`llm/config.rs` 仍使用旧配置、固定推理枚举及 Agent RetryPolicy。它们是 B/C 的迁移边界，不是假装已统一的能力服务。
3. `ImageRef` 仍由现有图片模块拥有，通用消息引用该不可变 DTO。`RequestImageResolver` 隔离实际存储；B 应使视觉、预检、主预算和压缩读取统一能力，同时保留图片模型切换拒绝行为。
4. 三种具体适配器已经独立，B 可围绕 `config.rs`、`adapters/common.rs` 的兼容事实与 provider 数据构建 resolver；不要把厂商判断放回主 Loop。
5. 原 reasoning `provider_item` 回放和厂商 URL/profile 兼容按要求保留，跨域回放约束留给 D；A 未将旧私有数据声明为可信 ReplayEnvelope。
6. 尚未运行 9 个外部厂商/Ollama live 测试及 5 个专用 bridge runner，没有复制源目录凭据。相关测试和已更新入口保留，可按各阶段授权环境继续验证。

协调任务可使用 `git diff --binary --output=<阶段补丁路径> f5ee96508f1a12f8165c857397a961b2371b15df HEAD` 导出纯阶段产出。源目录集成及后续阶段由协调任务负责。
