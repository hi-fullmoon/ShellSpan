# macOS 与 SSH 完善阶段 1

## SSH Host Direct 收尾回归

`verify_linux_host.py --output <新的忽略目录> --profiles <一到两个已保存配置名称>` 使用 debug-only `--native-host-check` 和现有钥匙串引用运行固定 Linux root 原生检查，不启动模型、不接管用户已有会话。正常退出／超时／取消／源断连使用实际控制器；客户端崩溃只由父进程 kill／wait 自己的 Child，再凭原 custody 清理，不按保存 PID 选择远端资源。失败轮及后续恢复报告分别保存，不将新成功写回旧失败；旧应用债务继续保留。`SHELLSPAN_LINUX_HOST_RECORDING=<该目录> pnpm exec vitest run scripts/__tests__/linux-host-recording.test.mjs` 核验第一台实际记录的两项回归；这不把第二台失败或整个阶段改记通过。

`--native-host-check <新的空绝对目录> <配置名称> handshake` 仅调试无认证的 libssh2 握手、算法与 TCP_NODELAY 对照以及 known_hosts 校验，不读取凭据或执行命令。每项有 30 秒握手期限，记录真实服务器 banner、协商结果和耗时；诊断偏好不进入生产 SSH 配置，也不改变服务器或主机信任。

`cargo test --manifest-path src-tauri/Cargo.toml host_handshake_has_independent_timeout_and_restores_session_io_timeout -- --ignored --test-threads=1` 用自有真实 sshd 和透明 TCP 转发延迟真实服务器字节 16 秒，核对独立握手期限以及握手后的原有 15 秒 I/O 期限。它不生成 SSH 响应，也不代替用户主机的稳定性验收；取消与外层截止时间另由 `skill_scoped_connection_cancellation_and_deadline_join_stalled_handshake` 回归核验。

`SHELLSPAN_LINUX_HOST_ORIGINAL_RECOVERY_REPORT=<原目录中独立保存的成功恢复 JSON> pnpm exec vitest run scripts/__tests__/linux-host-recording.test.mjs` 核对原 started／未确认执行记录及原失败恢复报告仍保留，并单独核对后续原 capsule 清理成功。缺少真实记录时 skipped；它不把原执行或完整主机验收改记通过。

`SHELLSPAN_LINUX_HOST_STARTUP_RECORDING=<原 admission=unknown 的独立验收目录> pnpm exec vitest run scripts/__tests__/linux-host-recording.test.mjs` 核对真实启动中断及原 capsule 恢复仍 uncertain、债务和 custody 保留。debug-only `recover` 接受同一 profile 的原启动中断记录，但必须同时有精确的一条 debt／custody；最终清理权限仍由原受保护 capsule 和签名回执核验，目录不存在不能作为资源终态证明。

`host_control_channel_waits_until_its_deadline_for_delayed_server_bytes -- --ignored --test-threads=1` 用自有真实 sshd 和透明 TCP 转发延迟认证后的真实服务器响应 3 秒，验证通道请求不会被 2 秒阻塞 I/O 提前截断；同一连接上的 100 毫秒截止时间仍在 1 秒内返回，阻塞模式恢复。运行时传输改为短 exec 启动器及两行标准 JSON stdin（源码、原请求），原控制器源码和 capsule 摘要保持兼容。

`python3 tests/agent-shell-sandbox-macos-ssh/test_host_controller.py` 使用本机真实自有 Child 验证正常退出、超时、签名回执和错误密钥拒绝。`cargo test --manifest-path src-tauri/Cargo.toml host_tests -- --ignored --test-threads=1` 显式运行自有普通账户 sshd、真实系统钥匙串、生产 NativeToolEngine 单次审批及清理 capsule 回归。测试只使用新临时资源，不连接用户配置，不代替真实 Linux／root 双身份工作台验收，不修改旧债务。所有测试目录及报告继续按阶段 2 的保留边界记录。

## 双目标与窄恢复界面

设置 `SHELLSPAN_SANDBOX_REVIEW_TWO_TARGETS=1` 后用 `launch_remote_workbench.py` 启动新的远端 fixture。它提供同一普通账户／自有 sshd 的两个真实独立 PTY 和目录，不是不同账户或不同主机证明。工具栏使用真实源状态切换；在原 Wry 加载 `target-switch-native.tsx` 的 `verificationMatrix()`，调用生产 hook／IPC 核对 11 项完成及在途结果失效。`pendingA()` 使用真实模型和精确自有命令等待审批；无模型请求、锁屏或未确认终态时保留 pending。

`export_recovery_render_prefix.py --journal <精确自有真实日志> --output <新目录>` 只导出真实已批准／派发事件的原始前缀。通过 `launch_remote_workbench.py --local --replay-journal <导出的 jsonl>` 在新状态目录进行渲染验收；不复制 custody／凭据／live grants，不把它当作资源恢复或历史清理证明。debug-only `sandbox_settings_review_window_size` 仅允许 360／480／620／960 的自有窗口宽度，不增加生产窗口权限。保存中英文实际 AX／截图、DOM 实际宽度与按钮边界；`inspect_narrow_recovery.py` 交叉核对当前精确证据，`SHELLSPAN_STAGE2_NARROW_FIXTURE=<目录> pnpm exec vitest run src/components/ai/__tests__/recorded-narrow-recovery.test.ts` 执行两个真实记录回归。

本地 fixture 收尾同样调用 `sandbox_settings_review_finish`：等待新建 PTY 的实际 Child wait 和源线程 join，只确认本次拥有的资源。导入日志里的历史 request/start 不表示新模型请求；必须核对前缀之后的事件。双 SSH 源的 finish 会关闭并 join 两个源，然后 wait 仍驻留的原始自有 server Child。Mac 锁屏导致收尾无法操作时保留句柄与待确认状态，不按历史 PID／名称补清理。

## 完整工作台恢复与活动资源验收

`launch_recovery_workbench.py --app-name "ShellSpan Recovery New" --output <新的忽略目录>` 保留新建 App 的实际 Child。先通过真实 controller 选择 `fixture/owned-project`、workspace 和请求批准；模型生成并显式批准固定 `printf started > recovery-started; sleep 120; printf ended > recovery-ended` 后，在输出根创建 `interrupt-owned-app` 请求文件。runner 再核对真实派发 journal、started 效果及 ended absent，仅终止自己的 Child，随后在同状态目录重启。未达到该边界时不强制中断。

工作台显示恢复门禁，通过精确自有回执的暂存／还原实测 uncertain 阻止与签名清理确认。结束中断回合后选择新会话及目录，重新请求并显式批准 `printf fresh > recovery-fresh`。使用 `inspect_recovery_workbench.py --output <该目录> --report-name <新文件名>` 交叉核对实际 UI、journal、marker 和数据库计数；报告不覆盖旧文件，不导出 custody 或 grant proof。`--reopen-existing --app-name <新名称>` 仅用于同一已记录本地 fixture 的后续 debug 修订，不能用于认领历史资源。

`sandbox-activity-native.ts` 的 `run(<本次自有项目>)` 在独立 Wry 的实际公共 IPC 上建立真实模型父／子 Agent／fleet。自有项目需要已有 `child-rebind`、`fleet-rebind` 子目录。只批准精确后台命令，活动时拒绝旧绑定改写／策略变更，取消后通过显式新会话选择新目录；既有目录不可改写。保存真实控制台 AX 为 `activity-final.ax.txt` 后，用 `inspect_activity_workbench.py --output <该目录>` 导出白名单终态报告。该入口在 fleet 活动时 abort，不声称四角色完成。

记录回归使用 `SHELLSPAN_STAGE2_RECOVERY_FIXTURE=<真实恢复目录>` 和 `SHELLSPAN_STAGE2_ACTIVITY_FIXTURE=<真实不同绑定／活动目录>`。前端对应 `recorded-native-recovery.test.tsx`、`recorded-native-activity.test.tsx`；Rust 使用 `cargo test --manifest-path src-tauri/Cargo.toml recovery_recording -- --ignored`。两种前提分开提供；只有普通恢复记录不能代替不同绑定的委派记录。

`recovery-diagnostics.ts` 的 `beginHour(<原 session ID>)` 仅只读核对实际 active grant，并按后端原 expiresAt 时间观察真实到期。需要让签发授权的原 App 持续运行整段一小时；重启后的 none、缩短 TTL 或调时均不计长时段通过。开发源码变更可能使 Wry 页面重载，重载后可重新只读观察同一截止时间，不续期或重发资源批准。所有历史超时资源继续待确认。

更可靠的一小时入口：`launch_remote_workbench.py --local --app-name "ShellSpan Hour Acceptance" --output <新的忽略目录>` 创建原 App、自有项目和普通外部输入文件，路径分别见 `fixture/root-review-intent.json` 与 `launch.json`。在该 Wry 中调用 `sandbox-hour-native.ts` 的 `run(projectRoot, ownedReadFile)`，使用真实 MiniMax-M3、精确命令和生产 session 审批。debug-only 后端观察在原 Runtime 保存 `hour-initial.json`／`hour-expired.json`，不依赖页面或前台，生产 TTL 与时钟不变。到期后同一文件走新的 once 资源审批，生成 `hour-acceptance.json`。

原 App 必须保留；页面若重载，`finish(projectRoot, ownedReadFile)` 可以继续原 expired grant 的新审批，但不能用重启后的 none 替代。使用 `inspect_hour_workbench.py --output <该目录>` 独立核对真实审计、两次精确调用、原进程与实际经过时长。`SHELLSPAN_STAGE2_HOUR_FIXTURE=<真实目录> pnpm exec vitest run src/components/ai/__tests__/recorded-hour-authorization.test.ts` 在完整证据上执行两个回归，未提供实际记录时明确 skipped。

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

绑定变更验收使用新的 `launch_remote_workbench.py` 普通账户 SSH fixture。在真实 Wry 中加载 `sandbox-binding-native.ts`，`pending(root)` 请求固定自有命令；`reconnect()` 实际断连／重连并刷新原会话预检，`decideOld()` 核对旧审批在原 TTL 内被取消且没有派发。新会话的精确审批与实际效果分别记录。`inspect_binding_workbench.py --output <该目录>` 交叉核对 15 项真实日志／UI／资源事实。

`activity(root)` 先通过实际 SFTP 等到 started，再在活动期间核对目录／策略变更拒绝，实际重连后检查准确的原生进程终态和公共撤销审计。原目录不可改写；新目录由 owned fixture 创建，并以新会话／新审批执行。`inspect_binding_activity.py` 在 fixture 仍存活时核对 19 项事实；Web Inspector 截断的日志只能用标准 JSON decoder 读取完整字段，不能补造省略的数据。

收尾必须在原 App／Runtime 仍驻留时调用 debug-only `sandbox_settings_review_finish`，等待原生 shutdown、自有源线程 join、原始 SSH Child wait 和精确自有凭据释放，保存 `fixture-shutdown.json`。随后关闭实际主窗口并核对 `settings-review.json` 和 `launch-final.json`。不要用 Cmd-Q 的退出码代替回执，也不要从历史 PID／名称认领清理。`SHELLSPAN_STAGE2_BINDING_FIXTURE=<绑定目录> SHELLSPAN_STAGE2_CLOSE_FIXTURE=<退出目录> pnpm exec vitest run src/components/ai/__tests__/recorded-remote-binding.test.ts` 执行三个真实记录回归；缺少证据时明确 skipped。

追加 `--complete-recovery` 会运行本地 Wry 崩溃清理、真实 MiniMax 模型 WaitingApproval／已派发中断、两个远端 Agent Session 并发和 SSH Wry App 崩溃恢复。模型入口只读取现有默认路由的 credential reference，并为本次 UUID 清理胶囊使用真实独立 OS 钥匙串条目，产生实际 API 请求；不改写模型凭据，报告不导出凭据。中断仅针对本次 Popen，校验身份后 SIGKILL，由父进程 wait 回收；僵尸状态不作为仍运行的证明。

SSH 生命周期 fixture 由父进程持有独立 sshd；客户端崩溃时监听继续运行。测试 App 的 known_hosts 必须位于 fixture 状态目录，脚本还核对用户开发 known_hosts 的前后 SHA-256。多会话证据覆盖同一普通账户上的两个 profile、密钥、PTY、项目及 Agent Session，不覆盖不同真实账户或多个 App 共用状态目录。当前本地崩溃由独立控制器持有资源，重启须通过受保护胶囊和签名回执解除债务，不把副作用核对当作资源清理确认。没有胶囊的历史债务仍 uncertain。

`verify_local_crash.py` 通过生产 NativeAdapter 启动真实普通 Shell 和 Node 服务／代理，记录其实际资源后 SIGKILL 自有 Wry，随后在同一状态目录调用公开清理 IPC。核对精确 temp、实际进程、端口、单次效果、重复清理、PTY 零写入和门禁重开；不对历史 PID 发信号，不安装后台服务或额外依赖。

离线回归现在在同一 fixture 连续执行三轮，每轮分别保存 `ssh-offline-reconnect-cycle-{1,2,3}.json`。多个 App 共用状态目录的就近回归使用实际独立测试进程，验证 SQLite 事务门禁拒绝 foreign debt，证明范围为安全拒绝第二 App。

`inspect_recorded_resources.py --output <新的忽略目录>` 只读核对 stage1 验收中记录的精确远端目录和债务数据库；不扫描临时目录、不删除或发信号、不读取钥匙串。历史路径观察不提供清理权限，缺少可信本地资源回执时状态仍 pending。

`verify_stage1_closeout.py --output <新的忽略目录>` 补验首次固定预检控制器运行期间 SIGKILL 主 App，并默认重复 20 次真实密钥脱敏及 Wry AppExit 竞争。仅 debug 二进制在隔离 fixture 中启用有界时序屏障：实际控制器已分配真实 workspace／command temp，但固定 Shell 尚未 spawn；不修改预检命令、钥匙串、回执或恢复规则。主 App 被回收后释放屏障，固定预检真实执行、清理并签名，重启调用生产清理 IPC 验证门禁。这个窗口不证明固定 Shell 运行期间的硬中断或控制器自身崩溃。每轮失败均保留，最终报告不能用最后一轮覆盖前面的结果。完整 `--complete-recovery` 同时包含该入口。

追加 `--running-preflight` 覆盖已启动的真实固定预检 Shell：仅 debug seed 在原 `printf native-ready` 后追加自发 SIGSTOP，并将该次进程超时延至 15 秒，核对来自真实 Child 的 PID、实际父控制器和 OS 停止状态，然后 SIGKILL 本次主 App。控制器响应父管道 EOF，沿用实际拥有的进程组终止与确认路径，清理精确目录并签名；脚本不向历史 PID 发信号。普通生产预检保持原有超时设置，额外响应 EOF／Stop；此证据覆盖受控暂停的真实 Shell，不能外推未经时序注入的所有运行窗口或无限期恢复。完整 `--complete-recovery` 同时执行启动前和已启动两个入口。
