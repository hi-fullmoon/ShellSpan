# 凭据列表刷新回归测试

## 普通开发程序的只读检查

macOS 的 `pnpm tauri:dev` 会在 Cargo 编译完成后使用 `Apple Development` 身份签名，
为本次普通构建创建独立的开发 `.app`，校验 Apple 证书链及团队身份后启动。
运行中的应用不再依赖会被其他 Cargo 编译覆盖的目标文件；退出后清理本次生成的 `.app`。
签名或校验失败时停止启动，
不会回退到临时签名。其他平台继续使用原来的 Cargo 启动路径。
存在多个开发证书时，可用 `SHELLSPAN_DEV_SIGNING_IDENTITY` 指定本机身份名称或指纹；
该变量只标识证书，不包含私钥或密码。首次使用新身份仍需在系统窗口授权钥匙串访问。

运行 `pnpm tauri:dev --no-watch -- -- --check-keychain-access`。此入口仅在开发构建中启用，
使用普通程序的配置、数据库和默认模型路径读取现有钥匙串凭据，然后退出。
`KEYCHAIN_ACCESS_OK` 和退出码 0 才表示读取成功；无默认模型、无凭据、拒绝访问均失败。
不会显示凭据、修改授权、重置保险库或发送模型请求。
诊断模式不加载前端工作区，避免恢复连接或保存该进程的界面状态。
直接运行 `src-tauri/target/debug/ShellSpan --check-keychain-access` 可检查原始 Cargo 产物，
但会绕过正常启动的签名和隔离步骤；其他编译仍可能覆盖这个原始文件。

分别在进程重启和 Rust 重编译后执行，记录可执行文件的签名哈希。
固定验证副本读取成功，不能代替普通程序或新构建的检查结果。

`tauri.dev.conf.json` 的应用标识符不会为 Cargo 生成的开发程序提供稳定签名。
打包配置中的 `bundle.macOS.signingIdentity` 也不等于开发运行前已经签名。
若重编译后重新出现钥匙串拒绝，应先检查实际可执行文件的签名和本机可用身份。
跨构建稳定授权需要有效的 Apple 开发或 Developer ID 签名身份，并在每次开发构建
启动前使用同一身份签名，再对普通程序执行本项读取检查。

## 凭据管理界面回归

运行 `pnpm test:credential-refresh`。需要桌面会话、Rust/Tauri 编译环境和已解锁的系统钥匙串。

脚本启动独立的本地 Vite 服务及 Tauri 开发窗口，使用真实 IPC、开发数据库（`~/.shellspan-dev`）和开发钥匙串。测试使用连接表单提交所调用的 `addProfile` 创建唯一临时连接；随机密码仅在内存和系统钥匙串中保存，不连接 SSH 服务器。现有连接不会被修改。

验证内容：

- 凭据列表已有缓存时，创建连接后切回凭据页面，新凭据出现在实际渲染的列表中。
- 页面保持打开时，修改连接名称会更新凭据关联信息。
- 删除连接后，凭据从页面、状态缓存和数据库中消失。

成功或断言失败后，测试通过正式删除接口清理本次创建的连接及凭据。强制终止进程或系统钥匙串拒绝清理时，可能残留以 `credential-refresh-` 开头的测试连接，可在开发版连接管理中删除。测试结束后停止其启动的服务和进程。

普通单元测试继续覆盖加载失败与重复渲染：

```sh
pnpm test src/components/workbench/__tests__/keychain-refresh.test.tsx src/components/workbench/__tests__/keychain-panel.test.tsx
```
