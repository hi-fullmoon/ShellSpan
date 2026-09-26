# 凭据列表刷新回归测试

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
