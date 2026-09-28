# ShellSpan

简体中文 · [English](./README.en.md)

ShellSpan 是一款面向远程运维的桌面 SSH 客户端，集成终端、文件管理、监控和 AI 助手。

[下载安装](https://github.com/hi-fullmoon/ShellSpan/releases/latest) · [问题反馈](https://github.com/hi-fullmoon/ShellSpan/issues) · [贡献指南](./CONTRIBUTING.md)

## 主要功能

- **终端**：SSH 与本地终端、多标签会话、跳板机和端口转发
- **文件管理**：SFTP 双栏浏览、拖拽传输、断点续传和文件预览
- **连接管理**：保存连接，支持密码与私钥认证，通过系统钥匙串管理凭证
- **运维工具**：本机与远程监控、日志查看和部署管理
- **AI 助手**：结合终端会话执行任务，支持运维 Skill、操作审批和随时停止

## 产品截图

以下为 macOS 开发版的实际界面，展示本机监控、本地终端、项目文件浏览和终端智能体。

### 工作台

集中查看应用资源趋势、系统容量与连接健康状态。

![ShellSpan 工作台：应用资源趋势、系统概览与连接健康](./docs/screenshots/workbench.jpg)

### 终端

在终端中查看项目提交记录与目录内容；支持本地 Shell 与 SSH 会话。

![ShellSpan 终端：本地 Shell 中的项目提交记录与文件目录](./docs/screenshots/terminal.jpg)

### 文件管理

双栏浏览项目与文档目录；两侧可分别选择本地文件系统或远程 SFTP 连接。

![ShellSpan 文件管理：本地项目与文档目录的双栏浏览](./docs/screenshots/file-manager.jpg)

### AI 助手

在终端中打开 AI 助手，用自然语言描述任务。终端智能体结合当前会话执行命令，并根据实际输出总结结果。

**使用示例：了解当前项目**

进入项目目录，打开终端右上角的 AI 助手，输入：

> 请在当前终端执行只读命令，查看 package.json 的 name、version、scripts 和 dependencies，并列出 src 下的一级目录。然后用三句话总结项目技术栈与启动方式。不要修改文件，不要读取其他配置或凭据。

图中为实际执行结果：左侧显示终端命令与目录列表，右侧整理项目依赖、目录结构和启动命令。

![ShellSpan 终端智能体：执行项目只读检查并总结技术栈与启动方式](./docs/screenshots/ai-assistant.jpg)

## 技术栈

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · xterm.js

## 本地开发

环境要求：Node.js 24+、pnpm 11、Rust stable，以及 [Tauri 2 所需的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install       # 安装依赖
pnpm tauri:dev     # 启动桌面应用
pnpm test          # 运行单元测试
pnpm build         # 检查并构建前端
pnpm tauri:build   # 构建桌面安装包
```

## 许可证

[MIT](./LICENSE)
