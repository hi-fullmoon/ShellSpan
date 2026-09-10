# Agent 可视终端执行研发计划

> 依据：`docs/design/agent-visible-terminal-execution.md`
> 范围：首版 Phase 1（单命令可视执行）
> 执行方式：阶段串行；每个阶段使用独立 Codex 任务实施；前一阶段通过门禁并合入当前工作区后，下一阶段才能开始。

## 1. 交付边界

首版只交付用户显式选择的、前台、非交互、单命令可视执行。权限审批、目标冻结、风险分类、结构化文件/SFTP/MCP 工具保持原语义。TUI、REPL、密码或 OTP 输入、长期后台进程以及通用半交互能力不在本轮实现范围内。

全局完成条件：

- `direct` 为历史 Session 和新 Session 的兼容默认值；
- `boundTerminal` 命令在冻结的绑定终端实时显示，并返回正确、有界、脱敏的工具结果；
- 后端强制隔离用户输入和 Agent 输入；
- wrapper、BEGIN/END marker 不进入屏幕、AI context buffer 或 Session 日志；
- 完成、取消、接管、超时、断线、窗口销毁及 Runtime 退出都释放 lease；
- 本地 POSIX、远程 POSIX、Windows ConPTY 的端到端路径通过验证。

## 2. 阶段与门禁

### 阶段 1：Session 契约与执行方式选择

目标：建立向后兼容、可持久化且在 Session 创建后冻结的 `executionSurface`，暂不改变命令执行通道。

实施范围：

- Rust/TypeScript 增加 `direct | boundTerminal` 类型；
- Session Header、`session/created` 事件、创建请求、投影、IPC 与 fixture 串通字段；
- 历史日志缺字段时反序列化为 `direct`；
- Agent composer 在目标/权限区域提供“后台执行 / 可视终端”选择；
- 恢复历史 Session 时使用 Header 值，不受当前 composer 选择影响；
- 增加中英文文案与契约、迁移、前端控制器测试。

退出门禁：相关 Rust 单测、前端定向测试、TypeScript build 通过；既有 `direct` 行为未改变。

### 阶段 2：后端 Lease 与输入来源安全边界

进入条件：阶段 1 已通过并回收到主工作区。

目标：即使前端失效，也能由后端保证同一 terminal session 只有一个 Agent owner，且用户输入不会与 Agent 输入拼接。

实施范围：

- 新增 `TerminalLeaseManager` 与包含 terminal/agent/task/operation 身份的 lease；
- 将用户、Agent、System 输入路径显式分离；
- lease 存在时后端拒绝普通用户输入，Agent 写入校验 operation owner；
- 提供稳定的 busy、owner mismatch、taken over 等错误语义；
- 接入 terminal close、Agent cancel、timeout、Runtime shutdown 的幂等回收；
- lease 获取与 PTY operation 注册采用一致的失败回滚；
- 发布带 `operationId` 的 acquired/released 事件，并提供受控 takeover 命令。

退出门禁：覆盖单 owner、错误 owner、重复释放、注册回滚、输入拒绝、取消/断线/关闭竞态的 Rust 单测；普通用户终端输入在无 lease 时不回归。

### 阶段 3：PTY 协议分流与执行路由

进入条件：阶段 2 已通过并回收到主工作区。

目标：审批完成后按冻结的 `executionSurface` 路由命令，并把 raw、display、model/result 三条数据流严格分离。

实施范围：

- `run_terminal_command` 根据 Session Header 选择 `direct` 或 `pty`，其他工具不变；
- lease 只在 schema、目标、risk/effect、审批均完成后获取；
- 重构 PTY parser 为跨 chunk 的增量状态机；
- 认证 BEGIN/END，拒绝伪造 END，保留 END 后同 chunk 的真实 prompt；
- display 仅发送脱敏的合成命令行与真实程序输出；
- model/result 去 ANSI、限长、脱敏并维持 1 MiB capture/2 MiB protocol hard limit；
- 未知或不支持的 shell 明确回退到 `direct` 或拒绝，不套用错误 wrapper；
- 所有终态通过统一 cleanup 释放 operation 与 lease。

退出门禁：parser 分块矩阵、marker 伪造、wrapper 隐藏、prompt 保留、大输出、退出码、超时/取消测试通过；`direct` 回归测试通过。

### 阶段 4：前端 Lease 协调、占用提示与接管

进入条件：阶段 3 已通过并回收到主工作区。

目标：让用户能实时观察命令输出，明确知道输入被锁定，并能用一次动作中断并接管。

实施范围：

- `TerminalControllerLayer` 订阅 lease acquired/released，按 `operationId` 管理状态；
- acquired 后安装 display filter、增加输入抑制并完成有界 ready 握手；
- 显示 Agent、脱敏命令摘要、运行时长和“中断并接管”；
- 首次被阻止的键盘输入提供可访问提示，不静默丢弃；
- Esc 和按钮复用同一个幂等 takeover 动作；
- 占用期间保持滚动、选择、复制与搜索；
- released、rebind、dispose 和乱序/重复事件正确清理 filter、状态条和抑制计数。

退出门禁：前端 lease 生命周期、旧 operation 隔离、输入提示、单次接管、rebind/dispose、direct UI 回归测试通过；`pnpm test` 和 `pnpm build` 通过。

### 阶段 5：跨平台集成、异常恢复与发布门禁

进入条件：阶段 4 已通过并回收到主工作区。

目标：补齐端到端证据并把首版限制、回退行为和运维诊断固化。

实施范围：

- 增加本地 POSIX、远程 SSH POSIX、Windows ConPTY 集成覆盖；
- 验证大输出背压、已有半行输入、未确认用户提交、断线、超时、Agent 停止、窗口销毁、Runtime 重启和完成/接管竞态；
- 验证屏幕、AI context buffer、工具结果和 Session 日志的协议隐藏与敏感信息脱敏；
- 增加 feature rollout/诊断日志，默认行为仍为 `direct`；
- 更新用户文案和开发文档，明确非交互边界与 shell 状态限制；
- 运行完整 Rust/前端检查，并记录平台上无法自动执行的手工验证项。

退出门禁：设计文档第 16 节验收项逐条有自动化或手工证据；完整测试通过；没有遗留 lease、权限绕过或 `direct` 回归。

## 3. 串行协作规则

- 每个阶段开始前检查 `git status`，保留用户已有修改，不清理、不覆盖无关文件；
- 每个阶段只实现自身范围，不提前实现 Phase 2 的 `wait_terminal`、`write_terminal_input` 或 TUI/REPL；
- 阶段任务结束时报告改动文件、测试命令、未覆盖平台/风险以及下一阶段需要继承的约束；
- 若前一阶段未通过退出门禁，下一阶段不启动；
- 发现设计与代码基线冲突时，先以安全边界和向后兼容为准，并在阶段交付中记录决策。

## 4. 后续里程碑（不在本轮执行）

- Phase 2：基于 cursor 的有界半交互、`wait_terminal`、受控 `write_terminal_input` 及交互预算；
- Phase 3：VT screen model、alternate screen、TUI/REPL capability 白名单与跨平台可维护性研究。
