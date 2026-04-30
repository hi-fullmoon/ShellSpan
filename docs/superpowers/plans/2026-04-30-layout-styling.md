# 样式调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除文件管理器/终端/控制台/会话栏之间的间距和圆角，使用背景色分层区分区域，确保 dark/light 主题适配。

**架构：** 最小改动方案，仅修改现有组件和样式文件，不引入新的 CSS 变量，完全依赖现有的 dark/light 主题变量。

**技术栈：** React + Tailwind CSS + 自定义 CSS

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/App.tsx` | 主应用布局，包含文件管理器、终端、会话栏的容器 | 修改间距 |
| `src/styles/components.css` | 定义 `.surface` 和 `.surface-muted` 等通用组件样式 | 修改圆角 |
| `src/components/SessionTabs.tsx` | 会话标签栏组件 | 修改圆角和间距 |
| `src/components/FileManager.tsx` | 文件管理器组件 | 修改圆角 |
| `src/styles/scroll.css` | SplitLayout 的 sash 样式 | 可能需要调整 |

---

## Task 1: 修改 App.tsx 主容器间距

**Files:**
- Modify: `src/App.tsx:1243`

- [ ] **Step 1: 修改主容器间距**

将主容器的 `gap-1 p-0.5` 改为 `gap-0 p-0`：

```tsx
// 修改前
<div className="flex flex-1 gap-1 p-0.5 min-h-0">

// 修改后
<div className="flex flex-1 gap-0 p-0 min-h-0">
```

- [ ] **Step 2: 验证修改**

检查 `src/App.tsx` 第 1243 行，确认已改为 `gap-0 p-0`。

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "style: remove gaps and padding from main container"
```

---

## Task 2: 修改 components.css 移除 surface 圆角

**Files:**
- Modify: `src/styles/components.css:2-14`

- [ ] **Step 1: 修改 .surface 圆角**

将 `.surface` 的 `border-radius: 0.75rem` 改为 `border-radius: 0`：

```css
/* 修改前 */
.surface {
  border-radius: 0.75rem;
  backdrop-filter: blur(12px);
  background: var(--app-surface);
  box-shadow: var(--app-shadow);
  color: var(--app-text);
}

/* 修改后 */
.surface {
  border-radius: 0;
  backdrop-filter: blur(12px);
  background: var(--app-surface);
  box-shadow: var(--app-shadow);
  color: var(--app-text);
}
```

- [ ] **Step 2: 修改 .surface-muted 圆角**

将 `.surface-muted` 的 `border-radius: 0.75rem` 改为 `border-radius: 0`：

```css
/* 修改前 */
.surface-muted {
  border-radius: 0.75rem;
  border: 1px solid var(--app-border);
  color: var(--app-text);
}

/* 修改后 */
.surface-muted {
  border-radius: 0;
  border: 1px solid var(--app-border);
  color: var(--app-text);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/styles/components.css
git commit -m "style: remove border-radius from surface and surface-muted"
```

---

## Task 3: 修改 SessionTabs.tsx 移除圆角和间距

**Files:**
- Modify: `src/components/SessionTabs.tsx:296-302` 和 `322-354`

- [ ] **Step 1: 修改空状态容器**

将空状态容器的 `surface rounded-lg` 改为 `surface`：

```tsx
// 修改前 (第 298 行)
<div className="surface rounded-lg session-tabs-empty flex flex-col justify-center items-start gap-1 px-2 py-1.5 text-xs">

// 修改后
<div className="surface session-tabs-empty flex flex-col justify-center items-start gap-1 px-2 py-1.5 text-xs">
```

- [ ] **Step 2: 修改主容器**

将主容器的 `surface rounded-lg min-w-0 flex flex-col gap-1 p-1` 改为 `surface min-w-0 flex flex-col gap-0 p-0`：

```tsx
// 修改前 (第 322 行)
<div className="surface rounded-lg min-w-0 flex flex-col gap-1 p-1">

// 修改后
<div className="surface min-w-0 flex flex-col gap-0 p-0">
```

- [ ] **Step 3: Commit**

```bash
git add src/components/SessionTabs.tsx
git commit -m "style: remove border-radius and gaps from SessionTabs"
```

---

## Task 4: 修改 FileManager.tsx 移除圆角

**Files:**
- Modify: `src/components/FileManager.tsx:1789`

- [ ] **Step 1: 修改文件管理器容器**

将文件管理器容器的 `surface rounded-lg` 改为 `surface`：

```tsx
// 修改前 (第 1789 行)
<aside className="surface rounded-lg relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">

// 修改后
<aside className="surface relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">
```

- [ ] **Step 2: 修改内部 surface-muted 区域**

检查并移除 FileManager 内部使用 `surface-muted rounded-lg` 的地方：

```tsx
// 第 1804 行：将 surface-muted rounded-lg 改为 surface-muted
<div className="surface-muted rounded-lg flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">

// 改为
<div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
```

```tsx
// 第 1808 行：同上
<div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
```

- [ ] **Step 3: Commit**

```bash
git add src/components/FileManager.tsx
git commit -m "style: remove border-radius from FileManager"
```

---

## Task 5: 修改 TerminalPane.tsx 移除圆角

**Files:**
- Modify: `src/components/TerminalPane.tsx`

- [ ] **Step 1: 检查 TerminalPane 中的圆角**

TerminalPane 本身没有直接使用 `rounded-lg`，但检查其父容器在 `App.tsx` 中的使用：

```tsx
// App.tsx 第 1194 行
<section className="surface rounded-lg relative min-h-0 flex-1 overflow-hidden">

// 改为
<section className="surface relative min-h-0 flex-1 overflow-hidden">
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "style: remove border-radius from terminal container"
```

---

## Task 6: 验证主题适配

**Files:**
- 检查：`src/styles/base.css`

- [ ] **Step 1: 验证 dark 主题变量**

确认 `--app-surface` 和 `--app-surface-muted` 在 dark 主题下有合适的值：

```css
:root {
  --app-surface: rgba(15, 23, 42, 0.9);
  --app-surface-muted: rgba(2, 6, 23, 0.6);
}
```

- [ ] **Step 2: 验证 light 主题变量**

确认 `--app-surface` 和 `--app-surface-muted` 在 light 主题下有合适的值：

```css
:root[data-theme='light'] {
  --app-surface: rgba(255, 255, 255, 0.9);
  --app-surface-muted: rgba(241, 245, 249, 0.92);
}
```

- [ ] **Step 3: 运行应用验证**

```bash
npm run dev
```

在浏览器中打开应用，验证：
1. 文件管理器、终端、会话栏之间没有间距
2. 主要区域没有圆角
3. 背景色分层明显（文件管理器/终端使用 surface，会话栏使用 surface-muted）
4. 切换 dark/light 主题后效果正常

---

## 自审检查

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 移除文件管理器/终端/控制台/会话栏之间的间距 | Task 1, Task 3 |
| 移除主要面板/区域之间的圆角 | Task 2, Task 3, Task 4, Task 5 |
| 使用背景色分层区分不同区域 | Task 2（已存在，无需修改） |
| 确保 dark/light 主题适配 | Task 6 |

### Placeholder 检查

- [x] 无 "TBD"、"TODO" 等占位符
- [x] 所有步骤包含具体代码
- [x] 所有步骤包含具体命令

### 类型一致性检查

- [x] CSS 类名一致（`surface`、`surface-muted`）
- [x] 变量名一致（`--app-surface`、`--app-surface-muted`）
