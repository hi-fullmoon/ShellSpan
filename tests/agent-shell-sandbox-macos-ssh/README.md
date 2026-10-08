# macOS 与 SSH 完善阶段 1

```bash
python3 tests/agent-shell-sandbox-macos-ssh/verify_stage1.py --output .phase4-acceptance/stage1-new-run
```

输出必须是已有忽略目录中的新目录。脚本记录实际源码 SHA-256、基线 HEAD、二进制 SHA-256、命令退出码、原始日志、真实过程事实，以及独立 Wry 的退出和同数据目录恢复报告。重跑使用新目录，保留旧记录。阶段状态固定为待完成，不能由若干测试成功推导整阶段通过；阅读对应验收记录中的缺口。

新增回归使用真实进程、独立 Rust 测试应用、实际文件权限失败、SQLite、普通账户自有 loopback SSH fixture 和生产运行器。SSH 密钥由 fixture 生成并通过原有 CredentialManager 隔离存储；报告不导出密钥、token 或签名 proof。离线仅中断本次创建的 sshd 监听进程，按实际观察时长记录，重新打开同一自有 fixture 后用原 live job 核对签名清理。不会操作用户服务器、系统 SSH 配置或用户应用。

实际崩溃回归只对刚创建的 Child handle 发送终止信号；自有命令两秒自然结束，重启后仍保留债务。这个入口没有 Wry／模型 driver，不替代实际主工作台、模型 WaitingApproval 或 SSH App 崩溃验收。权限失败只修改临时目录的权限，并在断言前恢复，未确认清理不会被标记成功。

Wry 测试项目自身带实际 Node `package.json`，避免 Node 越过项目根读取外部仓库配置。与生产业务一样，不能通过扩大读取许可修复缺少项目配置的问题。

完整范围和当前结果见 [验收记录](../../docs/design/agent-shell-sandbox-macos-ssh-stage-1-acceptance.md)。

追加 `--complete-recovery` 会运行本地 Wry 崩溃清理、真实 MiniMax 模型 WaitingApproval／已派发中断、两个远端 Agent Session 并发和 SSH Wry App 崩溃恢复。模型入口只读取现有默认路由的 credential reference，并为本次 UUID 清理胶囊使用真实独立 OS 钥匙串条目，产生实际 API 请求；不改写模型凭据，报告不导出凭据。中断仅针对本次 Popen，校验身份后 SIGKILL，由父进程 wait 回收；僵尸状态不作为仍运行的证明。

SSH 生命周期 fixture 由父进程持有独立 sshd；客户端崩溃时监听继续运行。测试 App 的 known_hosts 必须位于 fixture 状态目录，脚本还核对用户开发 known_hosts 的前后 SHA-256。多会话证据覆盖同一普通账户上的两个 profile、密钥、PTY、项目及 Agent Session，不覆盖不同真实账户或多个 App 共用状态目录。当前本地崩溃由独立控制器持有资源，重启须通过受保护胶囊和签名回执解除债务，不把副作用核对当作资源清理确认。没有胶囊的历史债务仍 uncertain。

`verify_local_crash.py` 通过生产 NativeAdapter 启动真实普通 Shell 和 Node 服务／代理，记录其实际资源后 SIGKILL 自有 Wry，随后在同一状态目录调用公开清理 IPC。核对精确 temp、实际进程、端口、单次效果、重复清理、PTY 零写入和门禁重开；不对历史 PID 发信号，不安装后台服务或额外依赖。

离线回归现在在同一 fixture 连续执行三轮，每轮分别保存 `ssh-offline-reconnect-cycle-{1,2,3}.json`。多个 App 共用状态目录的就近回归使用实际独立测试进程，验证 SQLite 事务门禁拒绝 foreign debt，证明范围为安全拒绝第二 App。

`inspect_recorded_resources.py --output <新的忽略目录>` 只读核对 stage1 验收中记录的精确远端目录和债务数据库；不扫描临时目录、不删除或发信号、不读取钥匙串。历史路径观察不提供清理权限，缺少可信本地资源回执时状态仍 pending。
