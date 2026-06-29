# 会话标签编辑态输入框去边框设计文档

## 日期

2026-06-29

## 背景

TermBridge 顶部会话标签在编辑（重命名）状态下使用 `Input` 组件。当前 `SessionTabs.tsx` 的 className 中虽已设置 `border-none`，但 Chakra UI 的默认样式可能仍显示边框或 focus ring，视觉上不够干净。

## 目标

让顶部会话标签进入编辑态时，输入框不显示任何边框、outline 和 focus ring。

## 设计方案

采用 **CSS 强制清除方案（方案 A）**。在 `src/styles/session.css` 的 `.session-tab-input` 规则中追加 `!important` 声明，确保覆盖 Chakra UI 的默认样式。

### 具体改动

```css
.session-tab-input {
  background: color-mix(in srgb, var(--app-bg) 45%, var(--app-icon-bg) 55%);
  color: var(--app-text);
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}
```

### 影响范围

- 只影响 `src/styles/session.css` 中的 `.session-tab-input`。
- 不影响其他使用 `themed-input` 的输入框。

## 涉及文件

1. `src/styles/session.css` - 为 `.session-tab-input` 追加无边框样式。

## 实施计划

1. 修改 `src/styles/session.css`，在 `.session-tab-input` 中追加 `border: none !important`、`outline: none !important`、`box-shadow: none !important`。
2. 运行 `npm test -- src/components/__tests__/SessionTabs.test.tsx`，确认编辑重命名相关测试通过。
3. 可选：启动应用并双击会话标签进入编辑态，肉眼确认输入框无边框。
