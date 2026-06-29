# 会话标签编辑态输入框去边框实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除顶部会话标签编辑态输入框的边框、outline 和 focus ring。

**架构：** 在 `src/styles/session.css` 的 `.session-tab-input` 规则中追加 `!important` 样式，强制覆盖 Chakra UI 默认边框和 focus 样式。

**技术栈：** CSS + Tailwind CSS + React

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/styles/session.css` | 会话标签相关样式，包含 `.session-tab-input` | 修改 |

---

## Task 1: 为 `.session-tab-input` 追加无边框样式

**Files:**
- Modify: `src/styles/session.css:64-67`
- Test: `src/components/__tests__/SessionTabs.test.tsx`

**Interfaces:**
- Consumes: 现有的 `.session-tab-input` CSS 规则。
- Produces: 更新后的 `.session-tab-input` 规则，新增 `border: none !important`、`outline: none !important`、`box-shadow: none !important`。

- [ ] **Step 1: 修改 CSS**

将 `.session-tab-input` 改为：

```css
/* 修改前 */
.session-tab-input {
  background: color-mix(in srgb, var(--app-bg) 45%, var(--app-icon-bg) 55%);
  color: var(--app-text);
}

/* 修改后 */
.session-tab-input {
  background: color-mix(in srgb, var(--app-bg) 45%, var(--app-icon-bg) 55%);
  color: var(--app-text);
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}
```

- [ ] **Step 2: 运行相关测试**

```bash
npm test -- src/components/__tests__/SessionTabs.test.tsx
```

预期：所有测试通过。

- [ ] **Step 3: 验证修改**

检查 `src/styles/session.css`：
1. `.session-tab-input` 包含 `border: none !important`。
2. `.session-tab-input` 包含 `outline: none !important`。
3. `.session-tab-input` 包含 `box-shadow: none !important`。

- [ ] **Step 4: Commit**

```bash
git add src/styles/session.css
git commit -m "style(session-tabs): remove border and focus ring from edit input"
```

---

## Task 2: 手动验证

**Files:**
- 验证对象：`src/styles/session.css`

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 手动验证**

打开应用后：
1. 双击任意会话标签进入重命名编辑态。
2. 确认输入框没有边框、outline 和 focus ring。
3. 输入文字后按 Enter 或 Escape 退出编辑态，确认功能正常。

---

## 自审检查

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 编辑态输入框无默认边框 | Task 1 |
| 编辑态输入框无 outline | Task 1 |
| 编辑态输入框无 focus ring | Task 1 |
| 测试与手动验证 | Task 1, Task 2 |

### Placeholder 检查

- [x] 无 "TBD"、"TODO" 等占位符
- [x] 所有步骤包含具体代码
- [x] 所有步骤包含具体命令

### 类型一致性检查

- [x] 仅修改 CSS，无接口/类型变更
