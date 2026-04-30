# 样式调整设计文档

## 日期

2026-04-30

## 背景

当前 TermBridge 应用的文件管理器、终端、控制台、会话栏之间存在间距和圆角，视觉上不够紧凑。需要通过移除间距和圆角，使用背景色分层来区分不同区域，同时保持主题化支持。

## 目标

1. 移除文件管理器/终端/控制台/会话栏之间的间距
2. 移除主要面板/区域之间的圆角
3. 使用背景色分层区分不同区域
4. 确保 dark/light 主题适配

## 设计方案

采用**最小改动方案（方案 A）**，仅修改布局和容器样式，不引入新的 CSS 变量，完全依赖现有的 dark/light 主题变量。

### 间距调整

- **App.tsx 主容器**：将 `gap-1 p-0.5` 改为 `gap-0 p-0`
- **SplitLayout**：sash 保持 4px 宽度但视觉上紧贴
- **SessionTabs 容器**：移除 `gap-1` 和 `p-1`
- **FileManager 内部**：移除各区域之间的 gap

### 圆角移除

- **文件管理器容器**：移除 `rounded-lg`
- **终端区域**：移除 `rounded-lg`
- **会话栏**：移除 `rounded-lg`
- **SessionTabs**：移除 `rounded-lg`
- **保留**：按钮（`icon-btn`、`primary-btn`）、输入框、对话框等小组件的圆角

### 背景色分层

- **文件管理器/终端/控制台**：使用 `var(--app-surface)`
- **会话栏**：使用 `var(--app-surface-muted)`
- **当前状态**：文件管理器和终端已经使用 `surface` 类（即 `app-surface`），会话栏需要调整为 `app-surface-muted`

### 主题化

- 完全依赖现有的 `base.css` 中的 dark/light 变量
- 无需新增 CSS 变量

## 涉及文件

1. `src/App.tsx` - 调整主容器间距
2. `src/styles/components.css` - 调整 `surface` 和 `surface-muted` 的圆角
3. `src/components/SessionTabs.tsx` - 移除容器圆角和间距
4. `src/components/FileManager.tsx` - 移除容器圆角
5. `src/styles/scroll.css` - 可能需要调整 sash 样式

## 实施计划

1. 修改 `src/App.tsx` 主容器间距
2. 修改 `src/styles/components.css` 移除 `surface` 和 `surface-muted` 的圆角
3. 修改 `src/components/SessionTabs.tsx` 移除容器圆角和间距
4. 修改 `src/components/FileManager.tsx` 移除容器圆角
5. 验证 dark/light 主题下的效果
