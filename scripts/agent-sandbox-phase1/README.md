# 本地 Direct 沙箱验证

从仓库根目录运行。验证顺序为普通 Direct、原始 `nono`、加固后的 `nono` 和 Anthropic `srt` CLI。四者运行相同的 `/bin/sh -lc` 命令，各自使用新建的测试工作区、外部探针目录和临时目录。脚本以独立进程组模拟 Direct 的启动与停止方式，结果适用于此验证入口。ShellSpan 的生产程序、会话和配置均无需参与。

## macOS

需要 Rust 1.95、Node.js 22.12 或以上版本，以及 PATH 中的 `rg`。沙箱启动器的编译缓存统一位于 `src-tauri/target/agent-sandbox-probe/`，独立验证、桌面验收和手动内测包共用该目录。

```sh
npm install --prefix artifacts/tests/agent-sandbox-phase1/tools --ignore-scripts --no-audit --no-fund --save-exact @anthropic-ai/sandbox-runtime@0.0.83
cargo build --locked --manifest-path scripts/agent-sandbox-phase1/Cargo.toml --target-dir src-tauri/target/agent-sandbox-probe
node scripts/agent-sandbox-phase1/verify.mjs \
  src-tauri/target/agent-sandbox-probe/debug/shellspan-sandbox-probe \
  artifacts/tests/agent-sandbox-phase1/tools/node_modules/.bin/srt
```

macOS 使用短路径的私有测试目录，让 `srt` 的 UNIX 套接字地址满足系统长度限制。脚本执行完会清理测试目录。

加固组由测试程序对自己在 `/private/tmp` 下创建的两级父目录设置 `uchg`，工作区本身可以写入。测试程序尝试重命名已授权的工作区及其两级父目录，单独验证沙箱子进程无法清除父目录标志，并检查工作区内部的重命名和删除。每次命令结束后恢复测试目录标志。若验证进程被强制杀死，`fixture-root.txt` 记录该次生成的目录，可对这个临时目录执行 `chflags -R nouchg` 后清理。[Apple BSD 文件标志说明](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html)

## Linux

使用运行 Linux 内核的 Docker。测试容器使用非 root 账号、不挂载宿主路径、移除附加能力，并只保留回环网络。测试容器单独关闭 Docker 的默认 seccomp 及系统路径屏蔽，让内层 Bubblewrap 能创建独立的 PID 命名空间并挂载自己的 `/proc`。报告记录 `nono` 探测到的 Landlock 能力。

加固组显式调用 `Sandbox::apply_seccomp` 并传入 `SeccompOpts::network_baseline()`。启动器继续使用相同的文件策略与 `block_network()`，初始化失败时拒绝启动命令。测试保留原始 `apply_auto` 组，用真实 TCP 和 UDP 回显观察两组差异。[nono 0.82.0 源码](https://docs.rs/crate/nono/0.82.0/source/src/sandbox/linux.rs)

```sh
docker build -t shellspan-agent-sandbox-phase1:local scripts/agent-sandbox-phase1
container_id=$(docker create --network none --cap-drop ALL \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  shellspan-agent-sandbox-phase1:local)
docker start -a "$container_id"
mkdir -p artifacts/tests/agent-sandbox-phase1
docker cp "$container_id":/phase1-output/. artifacts/tests/agent-sandbox-phase1/
docker rm "$container_id"
```

## 判定

- 文件拒绝用例要求命令确实启动，并检查由验证程序控制的外部文件在宿主视图中的最终状态。工作区重命名后，验证程序检查原目录和替换目录，重命名发生在 Shell 已启动且等待 stdin 的时候。
- 网络探针只访问同一测试环境中的真实 TCP、UDP 回环回显服务。普通 Direct 先验证回显可达，再记录每个沙箱的实际限制。
- 生命周期用例在父进程的 PID 命名空间确认测试子进程已启动，发送取消信号或让截止时间到期，再确认子进程消失。报告记录子进程是否曾启动，以及是否在停止后存活。
- 每个后端各启动六次短命令，报告首次观测和后续样本。这是调试构建的启动与退出总耗时，包含启动器和 Shell，文件系统缓存未清空。

`report.json` 保存在 `artifacts/tests/agent-sandbox-phase1/run-*/`。任一验证项与预期不符时，脚本退出码为 1，报告仍会记录全部后端的结果。两项依赖均为 Apache-2.0。[nono Rust API](https://docs.rs/nono/0.82.0/nono/) · [srt 文档](https://github.com/anthropics/sandbox-runtime)

## 第二阶段的测试接入

Linux 容器用于技术验证，桌面交付验收面向 Windows 和 macOS。容器编译 ShellSpan 的库测试，使用现有原生工具授权和 `exec_command` 入口。测试专用启动器只在 Linux 的 `cfg(test)` 中可选。镜像将第一阶段的真实启动器和 Node 复制到验收环境，Tauri 桌面端无需启动。

```sh
docker build -t shellspan-agent-sandbox-phase1:local scripts/agent-sandbox-phase1
docker build -f scripts/agent-sandbox-phase1/Dockerfile.runtime \
  -t shellspan-sandbox-runtime-acceptance:local scripts/agent-sandbox-phase1
docker run --rm --cap-drop ALL --security-opt seccomp=unconfined \
  --mount "type=bind,source=$PWD,target=/workspace,readonly" \
  shellspan-sandbox-runtime-acceptance:local /bin/bash /workspace/scripts/agent-sandbox-phase1/run-runtime-linux.sh
```

运行时将源码复制到容器内部，Cargo 需要已缓存的依赖或可用的 crates.io 连接。测试使用有自己数据库和工作区的临时会话。验收覆盖默认关闭、授权后关闭、启动失败时禁止回退、授权工作区被替换、文件写入边界、UDP、标准流、退出码、取消和超时。复跑可通过 Docker 卷保留 Cargo 缓存与编译产物。

macOS 继续运行本页的独立验证入口。报告的 `managedWorkspaceLifecycle` 记录两条真实命令在独立的受管工作区并行运行，第一条收到 `SIGKILL` 后释放其目录保护，第二条仍受保护并正常完成。验证程序正常清理的范围包含被杀掉的子进程。验证程序自身被强制终止时，`managed-fixture-roots.json` 记录这一组独立临时路径。

## macOS 桌面验收包

在 macOS arm64 上从仓库根目录运行。首次运行需要安装前端依赖。

```sh
pnpm install --frozen-lockfile
node scripts/agent-sandbox-phase1/verify-mac-desktop.mjs
```

脚本生成并校验签名的 `ShellSpan Sandbox Acceptance.app`，使用独立应用标识、WebKit 数据目录和受管工作区。它在真实 WebKit 窗口中加载桌面验收页，使用实际 AI 设置开关、原生审批、Direct 进程和会话存储。固定命令通过现有的无模型验收入口提交。

退出信息通过独立文件描述符记录，退出码 `125` 在启动器失败与命令自己退出两种情况下仍能区分。应用在隔离数据目录持久保存受管目录身份和执行阶段，启动器在应用保存进程组后才接到执行许可。应用重启时，恢复逻辑只在确认命令尚未获准启动或原进程组已终止时解除目录保护。

验收脚本在加锁后尚未启动、命令正在运行、进程组已终止但仍未解除保护三个时点向应用发送 `SIGKILL`。重启后读取真实目录标志、执行记录和工作区文件。运行中崩溃的用例会在核实保护标志依然有效后，通知原测试命令结束。最后再重启一次，核对三条命令均未重跑。验收脚本不修改目录保护标志，失败时如果应用仍保留保护，`report.json` 会记录隔离目录。

报告、日志和运行记录保存在 `artifacts/tests/agent-sandbox-phase1/desktop-mac-*/`。默认从临时目录运行签名验收包，并在验收结束后清理该副本。运行 `node scripts/agent-sandbox-phase1/verify-mac-desktop.mjs --keep-app` 可将验收包一并保存在当次目录。复跑时脚本重新生成包内验收页的本地连接配置。

## macOS 手动内测包

在 macOS arm64 上从仓库根目录运行 `node scripts/agent-sandbox-phase1/build-mac-sandbox-preview.mjs`。产物保存在 `artifacts/tests/agent-sandbox-phase1/preview-mac-*/`。脚本启动完整 ShellSpan 界面的 `ShellSpan Sandbox Preview.app`，再次启动使用包旁的「启动沙箱内测.command」。工作区和应用数据分别保存在 `~/.shellspan-agent-sandbox-preview-*/home` 和同级的 `data` 中。运行时保护该目录，并拒绝上层路径可以移动的主目录布局。

在「设置 → AI → 终端 Agent」开启 Agent 沙箱后，从本地终端使用「直接执行」试用前台命令。三种审批模式共用同一沙箱。「帮我批准」沿用现有规则，符合条件的只读命令自动通过，写入、敏感路径和范围不明的命令仍需人工批准。「完全访问权限」保留启用时的确认，之后可执行的本地前台命令无需逐次批准，仍受沙箱的文件和网络限制。Agent 使用内测工作区作为命令起始目录。模型连接需在内测包中单独配置。关闭沙箱后，新开的普通本地终端从 macOS 登录用户的主目录启动，内测包会拒绝本地 Agent 命令。

应用本身使用 macOS 登录环境访问系统钥匙串。每个包有独立的钥匙串凭据库，终端和 Agent 使用受管工作区。构建脚本先用已签名的包完成 SSH 密码在真实钥匙串的写入、读回和清理，再打开内测窗口。

更新已在试用的包时，可传入 `--reuse-preview <旧内测包目录>`。新包沿用原来的内测数据和钥匙串标识，构建完成后等待手动切换。从 `/private/tmp` 或 `~/.shellspan/agent-sandbox` 下的旧内测包升级时，先退出旧包及其本地终端，构建脚本会复制工作区和应用数据到新目录。退出旧窗口后，使用新包旁的启动器。
