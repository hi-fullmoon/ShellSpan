# macOS 与 SSH 完善阶段 2：前置门禁核对

日期：2026-10-08。状态：**前置门禁未通过，阶段 2 待实施／待验收**。本记录没有主工作台通过结论。

## 本次实际核对

- 先读取 [阶段 1 验收记录](agent-shell-sandbox-macos-ssh-stage-1-acceptance.md)，其末尾明确要求阶段 1 未完成时不得开启阶段 2。
- HEAD 为 `689509decac0d39efbf08cf180d9e237d3212a86`；保留本次开始时全部未提交文件。本次仅增加前置核对脚本、此记录和计划链接，没有修改生产逻辑、界面或既有阶段 1 证据。
- 对 `.phase4-acceptance/stage1-final-r4-2026-10-08/report.json` 的 18 个源码 SHA-256 逐一核对，全部匹配；核对结束再次计算，`sourceUnchanged=true`。这只确认记录对应的源码未变化，不扩大旧验收范围。
- 当前生产路径核对：`NativeToolAdapter.configure` 配置持久账本；`NativeToolEngine.admit_operation` 核对恢复债务；`ProcessRegistryNative.ensure_capacity` 再核对债务与未确认终态；`prepare_for_shutdown` 保留债务错误。`DirectIntent` 只有当前内存实例能解除自身行，异常丢弃关闭后续派发，重启读取历史债务继续拒绝。
- 重新执行 `cargo test --manifest-path src-tauri/Cargo.toml direct_ownership -- --test-threads=1`：3 passed；执行 `agent_runtime::native::process::tests` 同参数：20 passed。进程组、取消、启动注册窗口和目录清理的真实生产层回归不代替工作台、模型、队列或 fleet 验收。
- 新证据：`.phase4-acceptance/stage2-prerequisites-2026-10-08/report.json`、`ownership.log`、`process.log`。新脚本 `tests/agent-shell-sandbox-macos-ssh/verify_stage2_prerequisites.py` 保存引用报告哈希、源码哈希和实际测试命令。它只核对前置证据，不具备认证整阶段的能力，最终退出码 2 表示阶段 2 门禁未通过，即使所选回归全部通过也不放行。

## 未解除的前置条件

| 条件 | 当前事实 | 后续所需证据／行为 |
| --- | --- | --- |
| 真实模型待审批／已授权未派发中断 | 最终修订没有通过记录；本次未执行模型请求 | 自有 Wry App 在各中断窗口留下真实模型、审批和恢复事实，证明旧授权不复活 |
| Wry 实际 pipeline unknown-dispatch 硬崩溃 | 资源层中断与正常恢复已有记录，不能替代该窗口 | 实际 pipeline 硬崩溃及重启，核对副作用、资源债务与派发门禁 |
| SSH 硬崩溃丢失 live cleanup key | 持久账本只保存债务，不保存可认领资源的凭据；没有可信历史资源解除 IPC | 先建立可验证的所属资源恢复契约，再完成真实崩溃验收；不得删除账本行、按 PID／名称清理或用自然结束解除 |
| 多远端会话、不同账户与反复断连 | 既有自有 fixture 的多个 job 不等于独立 Agent Session／账户组合 | 各独立生产入口与真实普通账户 fixture 的隔离、取消、重绑和清理事实 |

不能通过本次选择的回归消除上述缺口。全量 Rust 测试和全仓格式检查的既有失败继续以阶段 1 记录为准，本次没有重跑，也没有将它们改记通过。

## 阶段 2 验收矩阵

| 计划项 | 状态 | 必须记录的入口与事实 |
| --- | --- | --- |
| 首次选远端目录、预检、启动、执行及绑定变化 | 待完成 | 主工作台真实 SSH 路径；目标、账户、连接代际、目录和策略变化后的过期结果丢弃 |
| 设置、摘要、审批、工具结果与模型上下文一致 | 待完成 | 当前 `partial` 能力事实、中英文限制和未验证目标拒绝 |
| 授权申请、复用、撤销、过期和恢复 | 待完成 | 实际审批、活动进程终态及未确认时拒绝新派发 |
| 队列、子 Agent 和 fleet | 待完成 | 各生产入口、权限范围、过期审批和重绑行为 |
| 审批审计写入失败、错误去重、键盘和焦点 | 待完成 | 真实写入失败与实际主工作台操作；就近回归 |
| 宽窄容器、中英文、加载／失败／空态／恢复状态 | 待完成 | 实际 Wry 渲染与脱敏截图；组件和模型证据分开记录 |

本次没有阶段 2 截图或真实 UI 操作记录。阶段 1 必要缺口解除且证据匹配最终修订后，才开始此矩阵的生产修复和真实验收。
