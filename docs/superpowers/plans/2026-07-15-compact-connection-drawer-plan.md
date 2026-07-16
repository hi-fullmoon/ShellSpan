# Compact Connection Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the connection-form drawer and fix the four reported visual issues (loose spacing, heavy input focus ring, select showing raw key, select/input height mismatch).

**Architecture:** Keep the existing right-edge `Drawer` and `ConnectionForm` structure; only adjust the shared `Input`/`Select` primitives and the form/drawer layout classes. No new components or dependencies.

**Tech Stack:** React, TypeScript, Tailwind CSS, `@base-ui/react`, Vitest, React Testing Library.

## Global Constraints

- Keep the same form fields, validation, and auth logic.
- No new dependencies.
- Reuse the existing `Drawer`, `Input`, `Select`, `Button`, and `Label` primitives.
- Follow the existing casing and file paths; do not fix the unrelated pre-existing casing LSP errors.

---

### Task 1: Reduce Input focus ring

**Files:**
- Modify: `src/components/ui/input.tsx`
- Test: `src/components/ui/__tests__/input.test.tsx`

**Interfaces:**
- Consumes: none.
- Produces: `Input` component with `focus-visible:ring-1` instead of `focus-visible:ring-2`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../input';

describe('Input', () => {
  it('renders without shadow utilities', () => {
    render(<Input placeholder="Test input" />);
    const input = screen.getByPlaceholderText('Test input');
    expect(input).not.toHaveClass('shadow-sm');
    expect(input).not.toHaveClass('shadow');
    expect(input).not.toHaveClass('shadow-md');
    expect(input).not.toHaveClass('shadow-lg');
  });

  it('uses a single focus ring', () => {
    render(<Input placeholder="Test input" />);
    const input = screen.getByPlaceholderText('Test input');
    expect(input).toHaveClass('focus-visible:ring-1');
    expect(input).not.toHaveClass('focus-visible:ring-2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/ui/__tests__/input.test.tsx`

Expected: FAIL — `focus-visible:ring-1` not found.

- [ ] **Step 3: Update the Input component**

In `src/components/ui/input.tsx`, change the class string from `focus-visible:ring-2` to `focus-visible:ring-1`:

```tsx
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/ui/__tests__/input.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/input.tsx src/components/ui/__tests__/input.test.tsx
git commit -m "fix(ui/input): reduce focus ring to ring-1"
```

---

### Task 2: Fix Select dimensions, width, and focus ring

**Files:**
- Modify: `src/components/ui/select.tsx`
- Test: `src/components/ui/__tests__/select.test.tsx` (create)

**Interfaces:**
- Consumes: none.
- Produces: `SelectTrigger` with `h-9`, `w-full`, matching input padding, and `focus-visible:ring-1` / `aria-invalid:ring-1`.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/select.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('SelectTrigger', () => {
  it('matches input height and fills its container', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger data-testid="trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByTestId('trigger');
    expect(trigger).toHaveClass('data-[size=default]:h-9');
    expect(trigger).toHaveClass('w-full');
    expect(trigger).toHaveClass('px-3');
    expect(trigger).toHaveClass('py-1');
  });

  it('uses a single focus ring', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger data-testid="trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByTestId('trigger');
    expect(trigger).toHaveClass('focus-visible:ring-1');
    expect(trigger).not.toHaveClass('focus-visible:ring-3');
    expect(trigger).toHaveClass('aria-invalid:ring-1');
    expect(trigger).not.toHaveClass('aria-invalid:ring-3');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/ui/__tests__/select.test.tsx`

Expected: FAIL — classes `data-[size=default]:h-9`, `w-full`, `focus-visible:ring-1`, etc. not found.

- [ ] **Step 3: Update the SelectTrigger component**

In `src/components/ui/select.tsx`, update the `SelectTrigger` class string:

```tsx
function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'flex w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-3 py-1 pr-2 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  );
}
```

Key changes from the current implementation:
- `w-fit` → `w-full`
- `py-2 pr-2 pl-2.5` → `px-3 py-1 pr-2`
- `data-[size=default]:h-8` → `data-[size=default]:h-9`
- `focus-visible:ring-3` → `focus-visible:ring-1`
- `aria-invalid:ring-3` → `aria-invalid:ring-1`

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/ui/__tests__/select.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/select.tsx src/components/ui/__tests__/select.test.tsx
git commit -m "fix(ui/select): match input height, fill width, and soften focus ring"
```

---

### Task 3: Tighten the Drawer container

**Files:**
- Modify: `src/components/ui/drawer.tsx`
- Test: `src/components/ui/__tests__/drawer.test.tsx`

**Interfaces:**
- Consumes: none.
- Produces: `DrawerContent` with `w-[360px]`, `p-4`, `gap-2`, and `DrawerFooter` with `pt-3`.

- [ ] **Step 1: Write the failing test**

Update `src/components/ui/__tests__/drawer.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Drawer, DrawerContent } from '../drawer';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('Drawer', () => {
  it('uses CSS transitions for the overlay and popup', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const overlay = document.body.querySelector('[data-slot="drawer-overlay"]');
    const content = document.body.querySelector('[data-slot="drawer-content"]');

    expect(overlay).toHaveClass('transition-opacity');
    expect(overlay).toHaveClass('duration-200');
    expect(overlay).toHaveClass('data-starting-style:opacity-0');
    expect(overlay).toHaveClass('data-ending-style:opacity-0');

    expect(content).toHaveClass('transition-transform');
    expect(content).toHaveClass('duration-200');
    expect(content).toHaveClass('data-starting-style:translate-x-full');
    expect(content).toHaveClass('data-ending-style:translate-x-full');
  });

  it('uses a compact width and padding', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const content = document.body.querySelector('[data-slot="drawer-content"]');
    expect(content).toHaveClass('w-[360px]');
    expect(content).toHaveClass('p-4');
    expect(content).toHaveClass('gap-2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/ui/__tests__/drawer.test.tsx`

Expected: FAIL — `w-[360px]`, `p-4`, `gap-2` not found.

- [ ] **Step 3: Update the Drawer components**

In `src/components/ui/drawer.tsx`:

Update `DrawerContent`:

```tsx
function DrawerContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const { t } = useI18n();
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DialogPrimitive.Popup
        data-slot="drawer-content"
        className={cn(
          'fixed top-0 right-0 z-50 flex h-full w-[360px] max-w-[90vw] flex-col gap-2 border-l border-app-border bg-background p-4 shadow-[var(--shadow-dialog)] outline-none transition-transform duration-200 ease-out data-starting-style:translate-x-full data-ending-style:translate-x-full rounded-l-xl',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="drawer-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-4 right-4"
                size="icon"
              />
            }
          >
            <XIcon />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DrawerPortal>
  );
}
```

Update `DrawerHeader` right padding to `pr-6`:

```tsx
function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-2 pr-6', className)}
      {...props}
    />
  );
}
```

Update `DrawerFooter` top padding to `pt-3`:

```tsx
function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        'mt-auto flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/ui/__tests__/drawer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/drawer.tsx src/components/ui/__tests__/drawer.test.tsx
git commit -m "fix(ui/drawer): compact width, padding, and footer spacing"
```

---

### Task 4: Compact the ConnectionForm layout and render select labels

**Files:**
- Modify: `src/components/workbench/connection-form.tsx`
- Test: `src/components/workbench/__tests__/connection-form.test.tsx`

**Interfaces:**
- Consumes: `Drawer` (compact), `Input` (ring-1), `Select` (h-9, w-full, ring-1).
- Produces: `ConnectionForm` with `gap-2` form body, `gap-0.5` form rows, tighter jump-host box, and explicit `SelectValue` labels for both auth selects.

- [ ] **Step 1: Write the failing test**

Update `src/components/workbench/__tests__/connection-form.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ConnectionForm } from '../connection-form';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/lib/tauri', () => ({
  invokePickPrivateKeyFile: vi.fn(),
}));

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'secret',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('ConnectionForm', () => {
  it('renders the form body as a constrained scrollable region', () => {
    render(<ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} />);

    const formBody = document.body.querySelector(
      '[data-slot="drawer-content"] > div.overflow-y-auto',
    );
    expect(formBody).toBeInTheDocument();
    expect(formBody).toHaveClass('flex-1');
    expect(formBody).toHaveClass('min-h-0');
    expect(formBody).toHaveClass('gap-2');
  });

  it('renders the translated auth method label instead of the raw key', () => {
    render(<ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} />);

    const authSelect = document.body.querySelector('[data-slot="select-trigger"]');
    expect(authSelect).toHaveTextContent('connection.form.auth.password');
    expect(authSelect).not.toHaveTextContent('password');
  });

  it('resets form values when opening with a new profile', () => {
    const { rerender } = render(
      <ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} initial={profile} />,
    );

    const nameInput = document.body.querySelector('[data-slot="input"]') as HTMLInputElement;
    expect(nameInput.value).toBe('My Server');

    fireEvent.change(nameInput, { target: { value: 'Changed' } });
    expect(nameInput.value).toBe('Changed');

    const nextProfile: ConnectionProfile = { ...profile, id: 'p2', name: 'Other Server' };
    rerender(
      <ConnectionForm open={true} onClose={() => {}} onSubmit={() => {}} initial={nextProfile} />,
    );

    expect(nameInput.value).toBe('Other Server');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/workbench/__tests__/connection-form.test.tsx`

Expected: FAIL — `gap-2` not found on form body, and auth select shows `password` instead of `connection.form.auth.password`.

- [ ] **Step 3: Update the ConnectionForm component**

In `src/components/workbench/connection-form.tsx`, make these changes:

1. Add a helper near the component (or inline) that maps `AuthMethod` to its translated label:

```tsx
const authMethodLabels: Record<AuthMethod, string> = {
  password: 'connection.form.auth.password',
  key: 'connection.form.auth.key',
};
```

Because the mocked `t` returns the key itself, use the translation key string directly in the `SelectValue`.

2. In the main auth select, replace:

```tsx
<SelectTrigger>
  <SelectValue />
</SelectTrigger>
```

with:

```tsx
<SelectTrigger>
  <SelectValue>{t(authMethodLabels[form.authMethod])}</SelectValue>
</SelectTrigger>
```

3. In the jump-host auth select, replace:

```tsx
<SelectTrigger>
  <SelectValue />
</SelectTrigger>
```

with:

```tsx
<SelectTrigger>
  <SelectValue>{t(authMethodLabels[form.jumpHost.authMethod])}</SelectValue>
</SelectTrigger>
```

4. Tighten the form body:

```tsx
<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
```

5. Tighten the `FormRow` helper:

```tsx
const FormRow: React.FC<FormRowProps> = ({ label, error, children, className }) => {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error && <span className="text-xs text-app-error">{error}</span>}
    </div>
  );
};
```

6. Tighten the jump-host box:

```tsx
<div className="flex flex-col gap-2 rounded-lg border border-app-border bg-muted p-2.5">
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/workbench/__tests__/connection-form.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/connection-form.tsx src/components/workbench/__tests__/connection-form.test.tsx
git commit -m "feat(connection-form): compact layout and explicit select labels"
```

---

### Task 5: Final verification

**Files:**
- All modified files.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`

Expected: All tests pass.

- [ ] **Step 2: Run the build**

Run: `pnpm build`

Expected: Build succeeds with no type or lint errors.

- [ ] **Step 3: Manual visual check (if running the app is possible)**

- Open the workbench and click "新建连接".
- Confirm the drawer is narrower and tighter.
- Confirm input focus shows a subtle ring.
- Confirm the auth-method select shows the translated label.
- Confirm the select height matches the input height.
- Confirm the jump-host section expands with tight spacing.

- [ ] **Step 4: Commit any final fixes**

If any test or build issues were fixed, commit them.

---

## Self-review checklist

- [ ] Spec coverage: every requirement (width, padding, input ring, select height/width/label, form spacing, jump-host spacing) maps to a task.
- [ ] Placeholder scan: no TBD/TODO or vague instructions remain.
- [ ] Type consistency: `AuthMethod` is still the value type; only the display label changes.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-compact-connection-drawer-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?
