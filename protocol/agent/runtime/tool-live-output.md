# 工具运行期实时尾部快照协议（Tool Live Output）

## 定位与提交边界

`agent-tool-progress` 是**非持久化（ephemeral）**的运行期进度通道，用于向前端实时展示正在执行的终端/进程工具（`direct` 与 `boundTerminal`）的最近输出尾部。

- **不写入事件日志、不占用事件序号（`seq`）**，不影响事件流的「先落盘、后发布」事务语义。
- **不替代最终结果**：命令结束、取消或超时后，持久化结果仍由 `tool/result` 写入会话日志；前端收到 `tool/result` 或切换会话后必须清理对应 `callId` 的内存态进度并无缝切换为持久化输出。

## Tauri 事件结构

事件名：`agent-tool-progress`

```json
{
  "sessionId": "session-123",
  "callId": "call-456",
  "revision": 3,
  "tail": "Step 3/5: building image...\nStep 4/5: running tests...",
  "totalBytes": 4096,
  "truncated": false,
  "alternateScreen": false
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | `string` | 所属 Agent 会话 ID |
| `callId` | `string` | 所属工具调用 ID |
| `revision` | `number` (`u64`) | 单次调用内从 `1` 起严格单调递增的快照版本；乱序到达时按较新版本覆盖、丢弃旧版本 |
| `tail` | `string` | 经脱敏并裁剪后的尾部输出快照；最多 `40` 行、不超过 `8 KiB`（UTF-8 字符边界安全截断）；当 `alternateScreen` 为 `true` 时为空字符串 |
| `totalBytes` | `number` (`u64`) | 当前已观察到的输出总字节数（用于估算变化与诊断） |
| `truncated` | `boolean` | 是否因超出上游捕获上限或尾部窗口上限（`40` 行 / `8 KiB`）发生了截断 |
| `alternateScreen` | `boolean` | 是否检测到处于终端备用屏幕（如 `vim`、`top`、`less` 等全屏交互程序） |

## 脱敏与一致性要求

- **`direct` 路径**：快照在推送前经过与最终 `tool/result` 同源的已知连接凭据脱敏（`redact_known_secrets`）和通用敏感文本脱敏（`redact_sensitive_text`）。
- **`boundTerminal` 路径**：快照沿用与 `terminal_tools` 相同的双层脱敏（含先剥离 ANSI 再脱敏以防 ANSI 序列拆分凭据绕过），保证运行中展示内容与最终落盘内容语义一致。
- **未信任数据语义**：实时输出快照同样视为不可信显示数据，不得作为指令或生命周期裁决依据。

## 节流与生命周期约束

- **节流窗口**：同一 `callId` 每 `200 ms` 最多推送一次；快照内容（`tail`、`totalBytes`、`truncated`、`alternateScreen`）相对上次无变化时不发送。
- **快照语义**：每次发送均为完整尾部快照，丢失单次事件无需补拉或重放。
- **停止保证**：工具进入终态、超时或被取消时调用 `finish()` 立即关闭该 `callId` 的发布器；关闭后不再发出任何 `agent-tool-progress` 事件。
