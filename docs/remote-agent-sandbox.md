# 部署 Linux Agent 远端沙箱

ShellSpan 对已保存的 SSH 连接提供 Bubblewrap 沙箱。管理员配置一个远端工作区，选择只读或可写；两种模式都隔离进程并关闭网络。手动终端、手动 SFTP 和独立的远端 sudo 配置不受此策略控制。

1. **安装依赖。** 管理员使用远端发行版的包管理器安装 Bubblewrap。宿主还需 Python 3（`/usr/bin/python3`）、libseccomp（`libseccomp.so.2`）、util-linux 的 `findmnt` 和 OpenSSH。使用非 root SSH 账号和非交互 `/bin/sh`，确保该账号无法通过 SSH 环境变量或用户启动钩子干预执行器。内核需要允许该账号启动 Bubblewrap 所需的用户、进程、挂载和网络命名空间。ShellSpan 不安装软件、不修改 sudoers，也不调整内核或安全策略。
2. **准备目录。** 创建 root 拥有、普通用户不可改名或写入的 `/srv/shellspan-workspaces`。在其下为工作区挂载独立文件系统的根（例如专用卷，验证时可用 tmpfs），加 `nodev,nosuid`，不带子挂载。将工作区本身的权限授予该 SSH 账号。工作区路径形如 `/srv/shellspan-workspaces/project`。独立文件系统避免通过同一文件系统内的硬链接读取工作区外文件；执行器会拒绝普通目录、子挂载以及不满足挂载选项的配置。
3. **准备可信运行环境。** 在 `/var/lib/shellspan-sandbox/rootfs` 放置由管理员维护的最小 Linux 根文件系统。至少包含 `/bin/sh`、`/usr/bin/python3` 和 `/usr/lib/openssh/sftp-server`（可链接到根文件系统内实际包路径）。保留 `/dev`、`/proc`、`/tmp`、`/run` 和 `/srv` 的挂载位置。为实际 SSH 账号在根文件系统内的 `/etc/passwd` 增加同 UID/GID 的条目，密码字段填 `x`、家目录填 `/tmp`，供 SFTP 识别账号。根文件系统和上级目录须由 root 拥有且普通用户不可写。仅放置允许 Agent 读取的软件和数据，不要复制宿主的 `/etc`、账号家目录、凭据或套接字。另创建普通账号可读的 `/var/lib/shellspan-sandbox/outside-probe`，内容可为任意非敏感文本；该文件只用于验证宿主路径不可见。
4. **启用执行器。** 将仓库中的 [`shellspan-bwrap-v1`](../scripts/remote-sandbox/shellspan-bwrap-v1) 安装到 `/usr/local/libexec/shellspan-bwrap-v1`，由 root 拥有，权限 `0755`。在 `sshd_config` 添加 `Subsystem shellspan-bwrap-v1 /usr/local/libexec/shellspan-bwrap-v1`。用 `sshd -t` 检查配置，再按发行版流程重新加载 SSH 服务。现有 `Subsystem sftp` 保持不变。可参考[隔离验收镜像](../tests/ssh-e2e/Dockerfile.sandbox)中的 Alpine 软件和根文件系统布局；镜像和其运行参数仅用于测试。
5. **测试并保存。** 在 ShellSpan 的已保存连接设置中打开「配置远端沙箱」，填写工作区及模式，点击「测试执行器」。如缺包，界面只有在确认发行版和包管理器后才显示可复制的安装命令。管理员安装后重新测试。保存后，每次 Agent 命令或文件操作仍会在实际 SSH 通道上执行固定能力探针。对于已经打开的旧对话，工作区不一致时重新选择项目目录或新建对话。

沙箱会把软件环境和 `/proc` 暴露给内部进程，并提供私有临时目录。可写模式直接修改远端工作区，不提供事务或自动回滚。沙箱不为 CPU、内存和容量提供独立配额；有共享主机配额需求时由管理员在宿主边界配置。管理员须控制并审计 Linux 内核、账号、OpenSSH、执行器、根文件系统和工作区挂载。生产主机部署由管理员另行验收。

现有[独立 sudo 受管连接](remote-sudo-runner.md)的限制继续有效。用普通连接启用沙箱，用受管连接请求管理员放行的提权作业。

开发验证使用 `node scripts/verify-remote-sandbox.mjs`。加 `--ui` 会在桌面应用中通过真实 IPC 验证连接设置。脚本创建回环 SSH 容器和隔离的应用数据目录，以测试管理员身份在容器中安装 Bubblewrap，然后记录结果到 `artifacts/tests/remote-sandbox/`。
