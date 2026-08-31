# ShellSpan

ShellSpan 是一款面向远程运维的桌面 SSH 客户端，将终端、SFTP 文件管理和凭证管理整合在同一个应用中。

[下载安装](https://github.com/hi-fullmoon/ShellSpan/releases/latest) · [问题反馈](https://github.com/hi-fullmoon/ShellSpan/issues) · [贡献指南](./CONTRIBUTING.md)

> ShellSpan 仍在持续开发，功能、界面和配置格式可能发生变化。

## 主要功能

- **SSH 终端**：多标签会话、密码与私钥认证、跳板机、Known Hosts、端口转发、本地终端和外观定制
- **SFTP 文件管理**：本地与远程双栏浏览、拖拽传输、进度与取消、断点续传、文件预览和权限编辑
- **连接与凭证管理**：连接搜索、最近连接、Known Hosts 和系统钥匙串管理
- **运维工作台**：本机与远程监控、日志筛选与导出、设置中心和自动更新
- **终端 Agent**：在当前终端会话中通过结构化工具调用执行任务，并提供分级审批、停止和敏感信息脱敏；详见[使用指南](./docs/terminal-agent.md)

## 技术栈

React 19、TypeScript、Vite、Tailwind CSS 4、xterm.js、Zustand、Tauri 2 和 Rust。

## 本地开发

环境要求：Node.js 24、pnpm 11、Rust stable，以及 [Tauri 2 所需的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install       # 安装依赖
pnpm tauri:dev     # 启动桌面应用
pnpm dev           # 仅启动前端
pnpm test          # 运行单元测试
pnpm build         # 检查并构建前端
pnpm tauri:build   # 构建桌面安装包
```

## 许可证

[MIT](./LICENSE)
