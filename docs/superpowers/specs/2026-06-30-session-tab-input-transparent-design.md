# 会话标签编辑态输入框背景透明设计文档

## 日期

2026-06-30

## 背景

TermBridge 顶部会话标签在编辑（重命名）状态下使用 `Input` 组件。当前 `.session-tab-input` 设置了混合背景色，编辑框会覆盖一层不透明的背景，视觉上不够通透。

## 目标

让顶部会话标签进入编辑态时，输入框背景完全透明，透出标签页自身背景，同时保持文字颜色、字号、无边框和无 outline 的样式不变。

## 设计方案

采用 **直接修改输入框背景方案（方案 A）**。在 `src/styles/session.css` 的 `.session-tab-input` 规则中，将背景色从 `color-mix(...)` 改为 `transparent`。

### 具体改动

```css
.session-tab-input {
  background: transparent;
  color: var(--app-text);
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}
```

### 影响范围

- 只影响 `src/styles/session.css` 中的 `.session-tab-input`。
- `.session-tab-input` 仅在重命名状态下渲染，因此所有会话标签进入编辑态时都会应用透明背景。
- 不影响其他使用 `themed-input` 的输入框。

## 涉及文件

1. `src/styles/session.css` - 将 `.session-tab-input` 的 `background` 改为 `transparent`。
2. `src/components/__tests__/SessionTabs.test.tsx` - 可选：增加断言，验证编辑态输入框的 `background-color` 为 `transparent`。

## 实施计划

1. 修改 `src/styles/session.css` 中的 `.session-tab-input`，将 `background` 设置为 `transparent`。
2. 在 `SessionTabs.test.tsx` 的重命名测试中补充样式断言。
3. 运行 `pnpm test -- src/components/__tests__/SessionTabs.test.tsx` 确认测试通过。
4. 运行项目 lint/typecheck 命令确认无回归。
5. 可选：启动应用并双击会话标签进入编辑态，肉眼确认输入框背景透明。
