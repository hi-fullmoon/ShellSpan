# Session Tab Input Transparent Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the top session tab rename/edit input background transparent while preserving its text color, font size, and borderless style.

**Architecture:** A single CSS change in `src/styles/session.css` plus a regression test that reads the stylesheet source and asserts the `.session-tab-input` rule declares `background: transparent`. No React component changes are required because `.session-tab-input` is only rendered during rename.

**Tech Stack:** React, TypeScript, Tailwind CSS, Chakra UI, Vitest (jsdom), Vite.

## Global Constraints

- Do not change other input styles (e.g., `themed-input`).
- Preserve `color`, `border`, `outline`, and `box-shadow` declarations.
- The change applies to all session tabs in rename mode.

---

### Task 1: Make rename input background transparent

**Files:**
- Modify: `src/styles/session.css:64-70`
- Test: `src/components/__tests__/SessionTabsStyle.test.tsx`

**Interfaces:**
- Consumes: Existing `.session-tab-input` CSS class used in `src/components/SessionTabs.tsx:135`.
- Produces: Updated `.session-tab-input` rule with `background: transparent`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/SessionTabsStyle.test.tsx`:

```tsx
// @ts-nocheck
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sessionCss = readFileSync("src/styles/session.css", "utf8");

describe("SessionTabs transparent rename input", () => {
  it("uses a transparent background for the rename input", () => {
    expect(sessionCss).toContain(".session-tab-input");
    expect(sessionCss).toMatch(/\.session-tab-input\s*\{[^}]*background:\s*transparent/s);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/components/__tests__/SessionTabsStyle.test.tsx`

Expected: FAIL — `expected ... to match /\.session-tab-input\s*\{[^}]*background:\s*transparent/s`

- [ ] **Step 3: Update the CSS**

Edit `src/styles/session.css` and replace the `.session-tab-input` block:

```css
.session-tab-input {
  background: transparent;
  color: var(--app-text);
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm test -- src/components/__tests__/SessionTabsStyle.test.tsx`

Expected: PASS

- [ ] **Step 5: Run the full SessionTabs test suite**

Run: `pnpm test -- src/components/__tests__/SessionTabs.test.tsx`

Expected: all existing tests still pass

- [ ] **Step 6: Run typecheck/build**

Run: `pnpm run build`

Expected: TypeScript check and Vite build complete without errors

- [ ] **Step 7: Commit**

```bash
git add src/styles/session.css src/components/__tests__/SessionTabsStyle.test.tsx
git commit -m "feat(ui): make session tab rename input background transparent"
```

---

## Self-Review

- **Spec coverage:** The design spec calls for transparent background in rename mode, preserving other styles, and optionally adding a test — all covered in Task 1.
- **Placeholder scan:** No TBD/TODO/fill-in placeholders; exact file paths, code, and commands are provided.
- **Type consistency:** No new TypeScript interfaces; the test uses `@ts-nocheck` because `node:fs` is not in the project's DOM-only `tsconfig.json` types.
