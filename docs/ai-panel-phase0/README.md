# AI Panel Phase 0 基线

本目录保存 Phase 0 的固定测试输入和历史文本记录。现行视觉回归基线位于 `../ai-panel-phase5/evidence/`。所有事件和目标会话均为固定数据；生成证据时不访问 provider，也不发起真实模型请求。

## 冻结输入

- fixture 版本：`1`
- 时间起点：`2026-09-03T00:00:00.000Z`
- provider / model：`deepseek` / `deepseek-reasoner`
- reasoning level：`medium`
- permission：`requestApproval`
- 视口 / DPR：`1280 × 900` / `1`
- AI Panel 表面：`720 × 900`
- 主题 / 字号 / locale：`light` / `16px` / `zh-CN`
- reduced motion：`reduce`
- 用户输入：`hello`

ShellSpan 的场景定义位于 `src/test/fixtures/agent-session-baseline.ts`，覆盖：

| Fixture id | 场景 |
| --- | --- |
| `hello` | system/context/reasoning/final answer 基准 |
| `direct-answer` | 无 reasoning |
| `streaming-reasoning` | reasoning 流式增量 |
| `single-tool` | 单工具调用与结果 |
| `multiple-tools` | 多工具调用 |
| `retry-success` | retry 后成功 |
| `provider-error` | provider 失败 |
| `max-tokens` | length / max tokens 结束 |
| `cancelled` | 中断取消 |
| `partial-history` | 缺失前部事件的窗口 |
| `pagination` | older/current 两页重组 |
| `compaction` | 完成后追加结构化压缩事件且聊天/统计不漂移 |
| `missing-usage` | provider 未返回 usage |

## 稳定性门禁

运行：

```sh
pnpm test:ai:phase0
```

该命令先验证所有 fixture 的确定性、投影与分页合同，再启动只在 Vite dev 模式可用的基线页面，使用 Playwright 在两个独立浏览器 context 中连续捕获事件 JSON、真实 AI Panel DOM 和整页截图并做字节级比较。它不会写入基线文件。

只有在有意刷新 before 证据时运行：

```sh
node scripts/ai-panel-phase0-baseline.mjs --write-before
```

基线页面入口为 `/?aiPhase0Baseline=<fixture-id>&theme=light`。正常生产启动不会加载该入口。

## 证据

- `evidence/workspace-before.txt`：开始实施前的分支、提交、工作区和相关文件摘要。
- `evidence/before/`：Phase 0 时 ShellSpan 实现的事件、语义树和 DOM。
- `evidence/target/`：DeepSeek Harness 固定会话的折叠/展开语义树、DOM 与源结构说明。
- `evidence/baseline-result.json`：当时两次连续捕获的环境与 SHA-256 记录，其中截图哈希仅作历史记录。
- `evidence/manifest.sha256`：保留的证据文件校验和。
- `fixtures/deepseek-target-hello.session.jsonl`：DeepSeek Harness keyless replay 的固定会话。

DeepSeek 目标证据通过其测试 scaffold 注入上述会话并重放，未连接 provider。需要重新观察目标页面时，从 `deepseek-harness` 仓库运行：

```sh
pnpm exec vitest run --config /Users/zhengbiwen/Developer/ShellSpan/scripts/vitest.ai-panel-phase0-target.config.mjs
```

测试会把临时认证地址写入 `/tmp/shellspan-phase0-target-ready.json`，捕获结束后创建 `/tmp/shellspan-phase0-target-done` 即可让测试正常退出。

## Phase 0 边界

Phase 0 冻结时的 Session Event v3 不能持久表达完整 system prompt、结构化 reasoning block、cache read/write 与 reasoning token。Phase 0 将这些固定为 `modelInput` / `expectedUsage` 的基准事实；当时的 `hello` UI 仍走既有 `<think>` 文本路径。把它们升级为可持久回放的协议与语义投影属于 Phase 1–4，本段只描述 before 证据，不代表当前生产合同。

因此，这套 fixture 可作为后续阶段的固定输入与验收预期，但不应被误解为已经补齐上述生产能力。
