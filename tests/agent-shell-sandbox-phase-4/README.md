# 阶段 4 真实 SSH 验证

仅使用项目自有隔离 fixture，不连接用户服务器。依赖在专属测试镜像构建时加入，不在生产探测中安装。Docker 使用原有普通权限，不允许为通过实验增加 privileged/cap-add/seccomp 或修改宿主 user namespace 设置。

```bash
docker build -t shellspan-sandbox-ssh-phase4:local tests/agent-shell-sandbox-phase-4
docker run --detach --name shellspan-sandbox-ssh-phase4 --publish 127.0.0.1:22226:22 shellspan-sandbox-ssh-phase4:local
```

使用既有 `tests/ssh-e2e` 的一次性测试账户，设置 `SHELLSPAN_E2E_SSH_FIXTURE=1`、`SHELLSPAN_E2E_SSH_HOST=127.0.0.1`、`SHELLSPAN_E2E_SSH_PORT=22226`、`SHELLSPAN_E2E_SSH_USERNAME=shellspan` 和相应 fixture 密码。密码不属于用户服务器凭据；不要把真实凭据传入命令行或报告。仅按完整名字显式运行以下 ignored 测试，不使用宽泛过滤运行其他安全实验。

```bash
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::remote_backend::tests::remote_backend_real_ssh_probe_reconnect_and_profile_account_drift -- --ignored --exact
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::remote_binding::tests::remote_binding_real_ssh_reconnect_account_auth_jump_and_disconnect_invalidate_approval -- --ignored --exact
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::remote_binding::tests::remote_host_real_native_approval_direct_cancel_and_residue_are_accurate -- --ignored --exact
```

首项执行生产 bounded reviewed SSH probe 两次，检查重新认证、profile 账户变更拒绝及基础设施事实。第二项打开真实 SSH shell 作为冻结源，验证同身份重连、账户/认证/reference/跳板变更使旧绑定失效；源终端零写入。第三项执行生产 NativeToolEngine 审批、真实后台 SSH Direct 与取消，独立 channel 核对短时进程残留及自然退出，结果不得虚报 terminationConfirmed；源终端零写入。

当前 ordinary Docker 目标缺 namespace 权限，预期 `infrastructureAvailable=true`、`launcherAvailable=false`、`workspaceVerified=false`、`admissionEnabled=false`。这是可复核的能力缺口，不是隔离验收通过。若环境事实改变，测试故意失败，需补真实受限验收后重新记录，不能直接打开门禁。

结束后仅停止、移除本次创建的确切 fixture 容器；不清理其他容器或应用配置。
