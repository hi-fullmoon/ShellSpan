# Linux x86_64 SSH 可视命令验收

Linux x86_64 支持登录 Shell 为 Bash 且 glibc 为 2.28 或更新的 2.x 版本的账户。随包 Bash 固定为 5.3 / Readline 8.3.6，以 AlmaLinux 8 的 glibc 2.28 为构建基线，并静态链接 `libtinfo`。构建时核查 Bash、适配模块和 relay 的 ELF 符号版本。SSH 所用的 SFTP 和可执行的私有临时目录须可用。musl、低于 2.28 的 glibc 和 Linux x86_64 Zsh 不在支持范围内。

`scripts/native-input/integration/build.py` 写入 `catalogue-linux-x86_64-glibc-2.28.json` 与同名 profile 下的 `bash`、`adapter.so`、`native-input-relay`。构建缓存与 ARM64 分开，最终资源目录共用。发布流程在独立的 Linux amd64 和 ARM64 runner 上构建，macOS 包收录两者，Windows 包收录 amd64 SSH 资源。`native:prepare` 复核源码和文件摘要，Tauri 沿用 `native-input/generated/` 资源映射。

Bash 的 SSH 加载流程根据远端平台选择清单。x86_64 将已校验的 Bash、adapter 和 relay 上传到本次连接的 `/tmp/.ss-nip-*` 目录，回读校验后再登录启动。服务器的 `/bin/bash`、`/etc/passwd` 和启动文件无需修改。普通断开时会尝试清理该目录；突然断网时，旧连接无法继续通过 SFTP 清理，重连创建新的目录和控制连接。

首次 SSH 连接使用 30 秒建立并认证传输。进入原生终端初始化后，探测、SFTP 传输、读回校验与 Shell 启动共享独立的 60 秒。准备阶段的 SFTP 调用沿用该阶段的剩余预算。该阶段超时后，客户端先关闭未就绪的传输，再用最多 10 秒建立一次普通 SSH，并在「可视命令」中说明回退原因。如果原生探测先拒绝了该环境，随后同一传输上的普通 Shell 启动超时，重试成功后保留原生探测的拒绝原因。遇到低于 glibc 2.28 的 Shell 时，新建 Agent 对话使用 Direct，已有对话须由用户明确切换，菜单显示检测到的 glibc 版本和最低要求。连接中的页签可取消 SSH，重连中的页签可取消替代连接并保留原页签。认证阶段超时或用户取消时不启动普通 SSH 重试。连接日志记录准备、上传、读回和 Shell 启动的耗时。

## 构建与包体对比

在 macOS ARM64 上运行。Docker 需能运行 `linux/amd64` 和 `linux/arm64` 容器；macOS Zsh 继续使用仓库固定的 macOS 27.0 SDK 和 Xcode（见 `scripts/native-input/acceptance/build-macos-editor.sh`）。若 amd64 模拟构建不可用，在原生 amd64 runner 上用发布工作流中同一条 Docker 构建命令生产资源，再导入验收资源目录进行 `--no-build --require-ssh` 检查。

```sh
pnpm install --frozen-lockfile
pnpm check:ci:static
cargo test --manifest-path src-tauri/Cargo.toml x86_64_ssh_only_admits_the_fixed_bash_readline_pair
cargo test --manifest-path src-tauri/Cargo.toml ssh_bash_targets_require_linux_and_x86_64_requires_glibc_228_or_newer
SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests pnpm native:prepare --acceptance --with-ssh
pnpm build
```

确认生成目录的 `resource-manifest.json` 同时列出 macOS ARM64、Linux ARM64 和 Linux x86_64 的 Bash 清单。以同一份代码和签名配置先打候选包，再暂存 x86_64 清单、重跑 `native:prepare --no-build` 打对照包。对照包只缺 x86_64 资源；两份 DMG 均保存在验收目录。

```sh
evidence="$PWD/artifacts/tests/agent-terminal-input/linux-x86_64-ssh"
catalogue="$PWD/artifacts/tests/native-input-p2/resources/native-input/catalogue-linux-x86_64-glibc-2.28.json"
export CARGO_TARGET_DIR="$PWD/src-tauri/target/releases/linux-x86_64-ssh-acceptance"
dmg_dir="$CARGO_TARGET_DIR/aarch64-apple-darwin/release/bundle/dmg"
mkdir -p "$evidence"
config='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}'
pnpm exec tauri build --target aarch64-apple-darwin --bundles app,dmg --config "$config"
cp "$dmg_dir"/*.dmg "$evidence/with-x86_64.dmg"

mv "$catalogue" "$evidence/catalogue-linux-x86_64-glibc-2.28.json"
SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests pnpm native:prepare --acceptance --no-build
pnpm exec tauri build --target aarch64-apple-darwin --bundles app,dmg --config "$config"
cp "$dmg_dir"/*.dmg "$evidence/without-x86_64.dmg"
mv "$evidence/catalogue-linux-x86_64-glibc-2.28.json" "$catalogue"
SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests pnpm native:prepare --acceptance --no-build --require-ssh
stat -f '%N %z bytes' "$evidence"/*.dmg
```

挂载两份 DMG，在候选 App 的 `Contents/Resources/native-input/generated` 中核对 x86_64 清单与三份文件，用 `file` 检查三者均为 x86-64 ELF，并用 `shasum -a 256` 对照清单。确认对照包没有 x86_64 清单和 profile，两包的 ARM64 清单与制品摘要相同。记录两份 DMG 字节数、增量字节数及百分比。若对照打包中途失败，先恢复验收目录暂存的清单，再继续。

## 实机验证

用同一份清单和制品分别验收 glibc 2.28、2.35、2.38 环境。另用低于 2.28 的主机确认普通 SSH 可用，终端 Agent 为新请求使用 Direct，提示显示检测到的版本和最低要求。

1. 在指定 x86_64 服务器上用普通 SSH 记录 `uname -sm`、`getconf GNU_LIBC_VERSION` 和 `getent passwd "$(id -un)" | cut -d: -f7` 的结果；确认账户可用 SFTP，`/tmp` 允许执行。随后从候选 App 新建 SSH 会话。在终端执行 `printf '%s\n' "$BASH_VERSION"`、`readlink /proc/$$/exe` 和 `sha256sum /proc/$$/exe`，核实运行的确是会话目录中与随包 SHA-256 匹配的 Bash 5.3；记录会话协商报告中的 Readline ABI 与 `verifiedProfileId`。用普通 SSH 复核账户登录 Shell 保持原样。
2. 在 App 的 Agent 执行方式中选择 **Visible command**。用只读的 `printf` 命令确认同一 SSH 终端出现草稿与审批；批准后只执行一次并返回输出。再用不同标记拒绝一次，确认没有执行。检查普通编辑和用户已有草稿未被替换。
3. 取消尚未提交的草稿，确认草稿从终端消失，没有远端输出或执行结果，之后仍可发起新命令。批准一个 `sleep 60` 后按现有取消流程停止，确认命令结束、提示符恢复，并且下一条命令需独立审批。
4. 在等待审批时断线并重连，确认新会话获得新的控制连接与私有 Bash 路径，旧草稿和审批不会重放；新命令仍可执行。再正常关闭，检查本次私有目录已清理。强制断网只检查旧控制连接失效与新连接隔离，不要求旧 SSH 通道在断网后完成 SFTP 清理。
5. 用对照 App 连接同一 x86_64 账户，确认普通 SSH 启动服务器原来的 Bash、Visible command 不可用，显式选择 **Direct** 后仍可经原审批流程执行只读命令。再复制候选 App，在副本中修改 Bash 或 adapter 的字节，保留清单原样并重新临时签名（`codesign --force --sign - /path/to/ShellSpan.app`），确认校验失败也回退；分别记录测试条件与实际启动的 Shell。
6. 用候选 App 连接已配置匹配 Shell 摘要的 Linux ARM64 Bash 和 Zsh 账户（glibc 2.36），确认各自原生 profile、执行与取消仍可用，仍运行原有登录 Shell。连接未匹配摘要的 ARM64 Bash 账户，确认仍以普通 SSH 启动且 Direct 可用。
