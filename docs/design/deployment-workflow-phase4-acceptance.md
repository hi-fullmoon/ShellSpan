# Deployment Workflow 阶段 4 验收证据

> 日期：2026-09-17  
> 范围：工作流编辑器与模板体验  
> 视觉夹具：`?deploymentVisual=1&scenario=<wide|medium|narrow|ai>&locale=zh-CN`

## 阶段 3 前置门禁

修改阶段 4 前运行：

```text
pnpm test:deployment:e2e
```

结果：3 passed，0 failed。真实隔离目标上的 SFTP 传输、Docker-in-Docker Compose runner、静态站点相对 `current` 原子切换、Nginx/HTTP 验证与固定恢复均通过。工作流 coordinator、高层 IPC 与“无 effectful 单节点旁路”测试保持成立。

## 实际渲染矩阵

使用 Playwright Chromium，viewport 为 `1500 × 900`，实际测量 `WorkbenchPage` 容器而非 viewport 断点。

| 场景 | 页面容器 | 实际结构 | 结果 |
| --- | ---: | --- | --- |
| 宽 | 1418 px | 256 px 工作流/节点库 + 784 px 画布滚动层 + 320 px 配置 | 通过；三栏均在容器内，配置与两侧滚动链可见 |
| 中 | 858 px | 824 px 画布 + 360 px 节点库 Drawer | 通过；侧栏隐藏，Drawer 有固定标题和独立正文滚动 |
| 窄 | 428 px | 396 px 完整拓扑列表 | 通过；画布隐藏，每个节点可配置输入 binding 并打开配置 Drawer |
| AI 挤压 | 778 px | 744 px 画布，右侧独立 AI 面板 | 通过；基于 container query 切换，未按 viewport 误回宽三栏 |

四个场景均检测为无文档级横向溢出；画布宽内容由自己的水平 `ScrollArea` 承担。

截图：

- [宽三栏](./evidence/deployment-workflow-phase4/wide.png)
- [中等容器 Drawer](./evidence/deployment-workflow-phase4/medium.png)
- [窄屏拓扑列表](./evidence/deployment-workflow-phase4/narrow.png)
- [AI 面板挤压](./evidence/deployment-workflow-phase4/ai.png)

## 键盘与焦点

在 428 px 窄容器中用键盘执行：

1. 聚焦“添加节点”并按 Enter，成功打开“节点库” Drawer；
2. 关闭后聚焦第一个“配置”按钮并按 Enter，成功打开“节点配置” Drawer；
3. Drawer 内存在可聚焦的端口 Select，打开后焦点停留在按钮型控件；
4. 组件回归测试验证画布节点 Enter 选择与 `Alt + Arrow` 布局移动。

## 自动化覆盖

- 模板：静态站点、Docker Compose、导入已构建文件 Beta、空白工作流；
- Zustand：模板创建、节点增删、binding 连接、依赖 binding 清理、语义/layout revision 分离、CAS 冲突保留草稿；
- 组件：可读 Select label、CardAction、宽画布/窄拓扑同源等价、Drawer 收缩链、键盘替代路径、Toast 去重；
- IPC/协议：工作流 高层命令参数映射、native catalog config schema/default config、双语键集合一致；
- 构建：TypeScript strict 与 Vite production build。
