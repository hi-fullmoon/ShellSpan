# TermBridge Modern Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh TermBridge's visual style to a modern, clean, warm-gray + teal SaaS aesthetic without changing layouts or behavior.

**Architecture:** Update the central color/spacing/shadow tokens in `src/styles/base.css`, then polish the shared UI primitives and the main chrome components (title bar, sidebar, workbench, terminal, SFTP) to consume the new tokens consistently. No new components or layout changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shadcn/base-ui, Lucide icons, Tauri 2.

## Global Constraints

- No layout restructuring; keep existing component structure and DOM hierarchy.
- No new features or workflows.
- Keep the existing Lucide icon set.
- No heavy animation beyond subtle hover/focus transitions (≤150ms).
- Both light and dark themes must render correctly.
- Run `pnpm build` and `pnpm test` after each task; no regressions.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/styles/base.css` | Single source of truth for color, radius, shadow, and font tokens. |
| `src/components/ui/*.tsx` | Shared primitives (button, input, card, dialog, etc.) that need token polish. |
| `src/components/titlebar/*.tsx` | Title bar, section nav, and window controls. |
| `src/components/layout/app-shell.tsx` | App shell, sidebar, and main content wrapper. |
| `src/components/workbench/*.tsx` | Workbench sidebar, connection list, connection form, known hosts, log panel. |
| `src/components/terminal/*.tsx` | Terminal tab bar, panes, context menus, new-tab menu, host-key dialog. |
| `src/components/sftp/*.tsx` | SFTP tab bar, panes, file list, breadcrumb, dialogs, transfer progress. |
| `src/components/ui/empty-state.tsx` | Empty-state illustration/text wrapper. |
| `src/components/ui/sonner.tsx` | Toast notification styling. |

---

## Task 1: Update design tokens in `src/styles/base.css`

**Files:**
- Modify: `src/styles/base.css`

**Interfaces:**
- Consumes: none.
- Produces: updated CSS custom properties for `--app-*`, `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, and `--radius`.

- [ ] **Step 1: Replace light-mode color tokens**

Update the `:root` block to the warm-gray + teal palette.

```css
:root {
  --app-bg: #fafaf9;
  --app-surface: #ffffff;
  --app-surface-muted: #f5f5f4;
  --app-text: #1c1917;
  --app-text-soft: #78716c;
  --app-border: #e7e5e4;
  --app-primary: #0d9488;
  --app-primary-text: #ffffff;
  --app-error: #dc2626;
  --app-warning: #d97706;
  --app-success: #16a34a;
  --radius: 0.625rem;
  --shadow-card: 0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 1px 3px 0 rgba(0, 0, 0, 0.03);
  --shadow-dialog: 0 24px 48px -12px rgba(0, 0, 0, 0.18);
  --shadow-toast: 0 12px 28px -8px rgba(0, 0, 0, 0.16);
  --background: var(--app-bg);
  --foreground: var(--app-text);
  --card: var(--app-surface);
  --card-foreground: var(--app-text);
  --popover: var(--app-surface);
  --popover-foreground: var(--app-text);
  --primary: var(--app-primary);
  --primary-foreground: var(--app-primary-text);
  --secondary: var(--app-surface-muted);
  --secondary-foreground: var(--app-text);
  --muted: var(--app-surface-muted);
  --muted-foreground: var(--app-text-soft);
  --accent: var(--app-surface-muted);
  --accent-foreground: var(--app-text);
  --destructive: var(--app-error);
  --border: var(--app-border);
  --input: var(--app-border);
  --ring: var(--app-primary);
  --chart-1: var(--app-primary);
  --chart-2: var(--app-text-soft);
  --chart-3: var(--app-surface-muted);
  --chart-4: var(--app-warning);
  --chart-5: var(--app-success);
  --sidebar: var(--app-surface-muted);
  --sidebar-foreground: var(--app-text);
  --sidebar-primary: var(--app-primary);
  --sidebar-primary-foreground: var(--app-primary-text);
  --sidebar-accent: var(--app-surface-muted);
  --sidebar-accent-foreground: var(--app-text);
  --sidebar-border: var(--app-border);
  --sidebar-ring: var(--app-primary);
}
```

- [ ] **Step 2: Replace dark-mode color tokens**

Update the `[data-theme="dark"]` block.

```css
[data-theme="dark"] {
  --app-bg: #0c0a09;
  --app-surface: #1c1917;
  --app-surface-muted: #292524;
  --app-text: #fafaf9;
  --app-text-soft: #a8a29e;
  --app-border: #44403c;
  --app-primary: #2dd4bf;
  --app-primary-text: #0c0a09;
  --app-error: #ef4444;
  --app-warning: #f59e0b;
  --app-success: #22c55e;
  --background: var(--app-bg);
  --foreground: var(--app-text);
  --card: var(--app-surface);
  --card-foreground: var(--app-text);
  --popover: var(--app-surface);
  --popover-foreground: var(--app-text);
  --primary: var(--app-primary);
  --primary-foreground: var(--app-primary-text);
  --secondary: var(--app-surface-muted);
  --secondary-foreground: var(--app-text);
  --muted: var(--app-surface-muted);
  --muted-foreground: var(--app-text-soft);
  --accent: var(--app-surface-muted);
  --accent-foreground: var(--app-text);
  --destructive: var(--app-error);
  --border: var(--app-border);
  --input: var(--app-border);
  --ring: var(--app-primary);
  --chart-1: var(--app-primary);
  --chart-2: var(--app-text-soft);
  --chart-3: var(--app-surface-muted);
  --chart-4: var(--app-warning);
  --chart-5: var(--app-success);
  --sidebar: var(--app-surface-muted);
  --sidebar-foreground: var(--app-text);
  --sidebar-primary: var(--app-primary);
  --sidebar-primary-foreground: var(--app-primary-text);
  --sidebar-accent: var(--app-surface-muted);
  --sidebar-accent-foreground: var(--app-text);
  --sidebar-border: var(--app-border);
  --sidebar-ring: var(--app-primary);
}
```

- [ ] **Step 3: Verify token build**

Run: `pnpm build`

Expected: passes with no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/styles/base.css
git commit -m "feat(style): update warm-gray + teal design tokens"
```

---

## Task 2: Polish shared UI primitives

**Files:**
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/dialog.tsx`
- Modify: `src/components/ui/drawer.tsx`
- Modify: `src/components/ui/dropdown-menu.tsx`
- Modify: `src/components/ui/alert-dialog.tsx`
- Modify: `src/components/ui/tabs.tsx`
- Modify: `src/components/ui/empty-state.tsx`
- Modify: `src/components/ui/sonner.tsx`
- Modify: `src/components/ui/badge.tsx` (if present)

**Interfaces:**
- Consumes: new tokens from `src/styles/base.css`.
- Produces: polished primitives with consistent radius, padding, shadows, and focus rings.

- [ ] **Step 1: Update button variants**

In `src/components/ui/button.tsx`, ensure the default radius is `rounded-md` (6px), default size padding is `h-9 px-3`, and sizes include `sm`, `default`, `lg`. Use the existing CVA pattern but confirm colors come from `bg-primary text-primary-foreground`, `bg-secondary text-secondary-foreground`, `hover:bg-accent`, etc. Add a subtle transition:

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 py-2',
        sm: 'h-8 rounded-md px-2.5 text-xs',
        lg: 'h-10 rounded-md px-4',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);
```

- [ ] **Step 2: Update input styling**

In `src/components/ui/input.tsx`, ensure the class uses the theme tokens and a consistent radius:

```tsx
className={cn(
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
  className,
)}
```

- [ ] **Step 3: Update dialog and alert-dialog chrome**

In `src/components/ui/dialog.tsx` and `src/components/ui/alert-dialog.tsx`, update overlay and content classes to use the new shadow and border radius:

```tsx
// DialogOverlay / AlertDialogOverlay
className={cn(
  'fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
  className,
)}

// DialogContent / AlertDialogContent
className={cn(
  'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-[var(--shadow-dialog)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
  className,
)}
```

- [ ] **Step 4: Update dropdown menu, drawer, tabs, empty-state, sonner, badge**

For each file, replace any hardcoded old colors (slate/gray references) with theme tokens and confirm radius/shadow consistency. In `src/components/ui/sonner.tsx`, ensure the toast uses the new `--shadow-toast` and border radius. In `src/components/ui/empty-state.tsx`, make the icon and text use `text-muted-foreground` and center the content with `gap-4`.

- [ ] **Step 5: Run tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui
git commit -m "feat(ui): polish shared primitives with new tokens"
```

---

## Task 3: Polish app chrome (title bar, sidebar, section nav)

**Files:**
- Modify: `src/components/titlebar/title-bar.tsx`
- Modify: `src/components/titlebar/section-nav.tsx`
- Modify: `src/components/titlebar/window-controls.tsx`
- Modify: `src/components/layout/app-shell.tsx`

**Interfaces:**
- Consumes: new tokens.
- Produces: flatter title bar and sidebar with pill-shaped active items.

- [ ] **Step 1: Flatten title bar**

In `src/components/titlebar/title-bar.tsx`, remove the bottom border or make it subtler, and use a clean surface color:

```tsx
className={cn(
  'flex h-10 w-full shrink-0 items-center justify-between bg-app-surface/90 backdrop-blur-sm',
  isMacOS && 'pl-[76px]',
)}
```

- [ ] **Step 2: Modernize section nav**

In `src/components/titlebar/section-nav.tsx`, ensure active section uses a rounded-full pill with a tinted background:

```tsx
className={cn(
  'flex items-center justify-center rounded-full px-3 py-1 text-xs font-medium transition-colors',
  active
    ? 'bg-app-primary/10 text-app-primary'
    : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
)}
```

- [ ] **Step 3: Update sidebar styling**

In `src/components/layout/app-shell.tsx`, ensure the sidebar has no border or a very subtle one, and the main content uses the app background:

```tsx
// Sidebar
className={cn(
  'flex h-full w-56 shrink-0 flex-col bg-app-surface-muted',
  className,
)}

// MainContent
className="flex h-full flex-1 flex-col overflow-hidden bg-app-bg"
```

- [ ] **Step 4: Run build and tests**

Run: `pnpm build && pnpm test`

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/titlebar src/components/layout/app-shell.tsx
git commit -m "feat(chrome): flatten title bar and sidebar"
```

---

## Task 4: Polish workbench surfaces

**Files:**
- Modify: `src/components/workbench/workbench-sidebar.tsx`
- Modify: `src/components/workbench/connection-list.tsx`
- Modify: `src/components/workbench/connection-form.tsx`
- Modify: `src/components/workbench/known-hosts-panel.tsx`
- Modify: `src/components/workbench/log-panel.tsx`

**Interfaces:**
- Consumes: new tokens, updated button/input primitives.
- Produces: polished workbench chrome and connection cards.

- [ ] **Step 1: Update sidebar nav items to pills**

In `src/components/workbench/workbench-sidebar.tsx`, replace the existing active item styling with a full pill using the primary subtle background:

```tsx
className={cn(
  'flex w-full items-center justify-start gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
  active
    ? 'bg-app-primary/10 text-app-primary'
    : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
)}
```

- [ ] **Step 2: Polish connection cards**

In `src/components/workbench/connection-list.tsx`, update the card style:

```tsx
className="group flex flex-col gap-3 rounded-[10px] border border-app-border bg-app-surface p-4 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]"
```

Update the icon container to use a softer primary background:

```tsx
className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary"
```

Update badge styles to use the muted surface for secondary tags and primary subtle for auth method.

- [ ] **Step 3: Polish form, known-hosts, and log panels**

In `src/components/workbench/connection-form.tsx`, `known-hosts-panel.tsx`, and `log-panel.tsx`, replace any hardcoded borders or backgrounds with theme tokens, ensure inputs use the updated input primitive, and use `text-muted-foreground` for helper text.

- [ ] **Step 4: Run tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench
git commit -m "feat(workbench): polish connection cards and workbench panels"
```

---

## Task 5: Polish terminal chrome

**Files:**
- Modify: `src/components/terminal/terminal-tab-bar.tsx`
- Modify: `src/components/terminal/terminal-pane.tsx`
- Modify: `src/components/terminal/new-tab-menu.tsx`
- Modify: `src/components/terminal/terminal-context-menu.tsx`
- Modify: `src/components/terminal/terminal-pane-context-menu.tsx`
- Modify: `src/components/terminal/host-key-dialog.tsx`
- Modify: `src/components/terminal/index.tsx`

**Interfaces:**
- Consumes: new tokens, updated primitives.
- Produces: polished terminal tab bar, panes, and menus.

- [ ] **Step 1: Update terminal tab bar**

In `src/components/terminal/terminal-tab-bar.tsx`, ensure tabs use a clean pill shape for the active tab, muted hover for inactive, and a subtle border between tabs:

```tsx
className={cn(
  'flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
  active
    ? 'bg-app-surface text-app-text shadow-sm'
    : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
)}
```

- [ ] **Step 2: Update terminal pane chrome**

In `src/components/terminal/terminal-pane.tsx`, ensure the pane wrapper uses the app background and any toolbar uses the surface color with a subtle border. Remove any heavy shadows.

- [ ] **Step 3: Update menus and dialogs**

In `src/components/terminal/terminal-context-menu.tsx`, `terminal-pane-context-menu.tsx`, and `new-tab-menu.tsx`, update menu items to use the new hover/active colors (`hover:bg-app-surface-muted`, `text-app-text`). In `host-key-dialog.tsx`, use the updated dialog primitives.

- [ ] **Step 4: Run tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal
git commit -m "feat(terminal): polish terminal tab bar and menus"
```

---

## Task 6: Polish SFTP surfaces

**Files:**
- Modify: `src/components/sftp/sftp-tab-bar.tsx`
- Modify: `src/components/sftp/sftp-pane.tsx`
- Modify: `src/components/sftp/sftp-file-list.tsx`
- Modify: `src/components/sftp/sftp-file-list-row.tsx`
- Modify: `src/components/sftp/sftp-file-list-header.tsx`
- Modify: `src/components/sftp/path-breadcrumb.tsx`
- Modify: `src/components/sftp/sftp-pane-actions.tsx`
- Modify: `src/components/sftp/sftp-new-connection-menu.tsx`
- Modify: `src/components/sftp/sftp-file-context-menu.tsx`
- Modify: `src/components/sftp/sftp-tab-context-menu.tsx`
- Modify: `src/components/sftp/sftp-dialogs.tsx`
- Modify: `src/components/sftp/transfer-progress.tsx`
- Modify: `src/components/sftp/index.tsx`

**Interfaces:**
- Consumes: new tokens, updated primitives.
- Produces: polished SFTP file list, toolbar, breadcrumb, and dialogs.

- [ ] **Step 1: Update SFTP tab bar and pane chrome**

In `src/components/sftp/sftp-tab-bar.tsx` and `src/components/sftp/sftp-pane.tsx`, apply the same pill-shaped active tab and clean toolbar treatment as the terminal tab bar. Use `bg-app-surface` for toolbars and `border-app-border` for separators.

- [ ] **Step 2: Update file list and header**

In `src/components/sftp/sftp-file-list.tsx` and `sftp-file-list-header.tsx`, ensure the header uses a soft surface background, rows use a subtle hover state (`hover:bg-app-surface-muted`), and selected rows use the primary subtle background (`bg-app-primary/10 text-app-primary`).

- [ ] **Step 3: Update breadcrumb and actions**

In `src/components/sftp/path-breadcrumb.tsx` and `sftp-pane-actions.tsx`, use the updated button/input primitives, replace hardcoded borders with theme tokens, and use `text-muted-foreground` for inactive path segments.

- [ ] **Step 4: Update menus, dialogs, and transfer progress**

In `src/components/sftp/sftp-file-context-menu.tsx`, `sftp-tab-context-menu.tsx`, `sftp-new-connection-menu.tsx`, `sftp-dialogs.tsx`, and `transfer-progress.tsx`, apply the updated menu, dialog, and badge colors. Ensure progress bars use the primary accent.

- [ ] **Step 5: Run tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/sftp
git commit -m "feat(sftp): polish file list, toolbar, and dialogs"
```

---

## Task 7: Final visual verification and build

**Files:**
- Modify: any remaining files with hardcoded old colors (found via search).

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a consistent visual refresh across the app.

- [ ] **Step 1: Search for remaining hardcoded colors**

Run: `rg -n "#(slate|gray|blue|indigo|zinc|neutral|stone)" src/components src/styles --type tsx --type css` (or use `grep` equivalent)

Expected: no remaining hardcoded neutral colors that should be theme tokens. Fix any stragglers.

- [ ] **Step 2: Verify light and dark modes**

Run: `pnpm tauri:dev` (or `pnpm dev` for a quick UI preview). Toggle between light and dark themes in app settings. Verify the workbench, terminal, and SFTP sections look clean in both modes.

- [ ] **Step 3: Run full checks**

Run: `pnpm build && pnpm test`

Expected: both pass with no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(style): finalize visual refresh across all surfaces"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - Color system updated: Task 1.
  - Shared primitives polished: Task 2.
  - App chrome (title bar, sidebar) polished: Task 3.
  - Workbench surfaces polished: Task 4.
  - Terminal surfaces polished: Task 5.
  - SFTP surfaces polished: Task 6.
  - Both themes verified: Task 7.
- **Placeholder scan:** No TBD/TODO or vague steps.
- **Type consistency:** All component references use existing file paths; no new props introduced.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-14-modern-visual-refresh.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach would you like?
