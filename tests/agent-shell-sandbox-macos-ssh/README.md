# macOS 与 SSH 完善阶段 1

## 阶段 2 分项入口

先读取当前阶段 1 完成决定和阶段 2 验收记录，生产 uncertain 门禁继续保留。启动本仓库 Vite（`127.0.0.1:1420`），构建当前原生 debug 二进制后，执行：

```bash
python3 tests/agent-shell-sandbox-macos-ssh/verify_stage2.py --output .phase4-acceptance/stage2-new-run
```

该入口运行真实 Wry、macOS SSH fixture、生产预检 hook 和 IPC，覆盖 StrictMode 及策略切回后的完成／在途结果失效。不使用 mock；记录源码／二进制哈希和用户 known_hosts 前后校验。退出 0 只表示本分项通过，整阶段始终保持 pending。

实际 controller 交互沿用 `--native-sandbox-settings-check <新的空绝对目录> root-entry`，设置 `SHELLSPAN_SANDBOX_SETTINGS_DEV_URL=http://127.0.0.1:1420`；`SHELLSPAN_SANDBOX_WORKBENCH_REMOTE=1` 使用自有普通账户 SSH fixture，`SHELLSPAN_SANDBOX_WORKBENCH_MODEL=1` 则在本地入口只读现有默认 MiniMax-M3 配置及其 credential reference。后者产生实际模型调用时必须只批准本次自有项目的固定命令；凭据访问失败／阻塞、没有模型请求或没有可信终态均保持待完成。不得把 UI 窗口关闭或 report 的 exitCode=0 自动解释为模型执行通过。旧前置核对脚本只保留历史用途。

## 阶段 2 公共 IPC 与凭据边界

补充公共 IPC 验收入口为 `verify_stage2_public_ipc.py --output <新的忽略目录>`，沿用同一 Vite 端口和当前 debug 二进制。该入口创建独立、不抢焦点的 Wry 窗口和真实 MiniMax 模型任务，不控制或关闭用户正在使用的验收窗口。显式五工具父范围的 Explorer 拒绝单独核对；正常终端默认父范围按生产策略继续过滤模型工具，只核对纯模型子任务／fleet 的继承、越界目标拒绝、一次性续跑拒绝及完成状态，不开放额外工具，也不代替子会话原生命令验收。失败和超时报告保留，超时不确认资源清理，不按历史 PID 补清理。

只读模型验收使用已安装 security-framework 的精确、非交互系统钥匙串查询；需要交互授权或条目不可用时明确失败，不修改 ACL、不迁移或复制 secret。`keychain::native_acceptance_tests` 使用本次生成的真实 OS 条目验证精确读取、无其他账户匹配、只读及清理行为，不能拿它冒充用户模型凭据可用。模型是否实际执行以新的 request/start、真实工具结果和资源证据为准。

## 阶段 1 原有入口

`verify_stage2_public_ipc.py --fleet-native --output <新的忽略目录>` 启动真实 fleet，精确批准 Operator 的一条 foreground marker 命令，其他角色不调用工具。start_fleet 的 Promise 会等待整个 fleet 结束，入口发起后同时轮询实际审批，最终再核对返回值；不改变审批 TTL。该证明不包含活动 fleet 后台取消。

`verify_stage2.py --bundle --output <新的忽略目录>` 建立单独命名的 App，launch.json 给出确切 bundle／PID，允许显式显示本轮窗口以提供真实渲染帧。保留 StrictMode、requestAnimationFrame 和实际 SSH 预检。超时即 unconfirmed；新窗口成功不能替代旧窗口清理回执。

`verify_stage2_public_ipc.py --child-native --output <新的忽略目录>` 使用真实 Operator 子模型、继承范围、精确自有 marker 命令审批和原生结果。只批准与预期命令及目录完全一致、无额外资源扩展的调用，偏离即拒绝；不代表 fleet 原生工具已经通过。

`launch_remote_workbench.py --local` 提供独立本地工作台及新建的精确普通读取文件，文件保留并在 launch.json 中记录，不从旧路径推断清理权限。`inspect_local_resources.py` 从实际 journal 导出 once/session、reused、撤销和原生 stdout 匹配事实，不导出 grant 或 bearer。

`recorded-sandbox-approval.test.tsx` 必须提供真实 Wry／模型／审计失败 fixture：设置 `SHELLSPAN_STAGE2_APPROVAL_FIXTURE=<该验收目录>` 后执行对应 Vitest。缺少记录时明确 skipped，不构造替代事件、快照或 mock IPC。`--local --replay-journal <精确自有 jsonl>` 在空目录门禁核对后只重读原始历史，原日志不改写、不复制凭据／live grant／资源归属，用于实际 Wry 的旧审批和恢复显示验收。

远端实际模型窗口可使用 `launch_remote_workbench.py --output <新的忽略目录>` 启动独立 App bundle，避免选择用户正在使用的窗口。入口仅提供真实 fixture，不自动选择策略或批准命令。`inspect_remote_workbench.py --output <本次目录>` 只读实际 journal、精确 marker 和债务数据库，导出白名单事实；marker 为同主机 OS 观察，不冒充 SFTP 验收。窗口退出、源码哈希与模型请求分别记录，整阶段保持 pending。

`inspect_stage2_timeout.py` 仅核对原 r2 超时报告所记录的精确目录和数据库。没有原 PTY handle／可信退出回执时保留 terminationConfirmed=false；cwd 查询为空和 debt=0 均不证明资源已清理，不按历史 PID／名称补认领。

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

`verify_stage1_closeout.py --output <新的忽略目录>` 补验首次固定预检控制器运行期间 SIGKILL 主 App，并默认重复 20 次真实密钥脱敏及 Wry AppExit 竞争。仅 debug 二进制在隔离 fixture 中启用有界时序屏障：实际控制器已分配真实 workspace／command temp，但固定 Shell 尚未 spawn；不修改预检命令、钥匙串、回执或恢复规则。主 App 被回收后释放屏障，固定预检真实执行、清理并签名，重启调用生产清理 IPC 验证门禁。这个窗口不证明固定 Shell 运行期间的硬中断或控制器自身崩溃。每轮失败均保留，最终报告不能用最后一轮覆盖前面的结果。完整 `--complete-recovery` 同时包含该入口。

追加 `--running-preflight` 覆盖已启动的真实固定预检 Shell：仅 debug seed 在原 `printf native-ready` 后追加自发 SIGSTOP，并将该次进程超时延至 15 秒，核对来自真实 Child 的 PID、实际父控制器和 OS 停止状态，然后 SIGKILL 本次主 App。控制器响应父管道 EOF，沿用实际拥有的进程组终止与确认路径，清理精确目录并签名；脚本不向历史 PID 发信号。普通生产预检保持原有超时设置，额外响应 EOF／Stop；此证据覆盖受控暂停的真实 Shell，不能外推未经时序注入的所有运行窗口或无限期恢复。完整 `--complete-recovery` 同时执行启动前和已启动两个入口。
