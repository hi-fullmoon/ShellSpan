# Connection Form Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the modal dialog around the connection form with a reusable right-edge drawer component that slides in from the right.

**Architecture:** Add a `Drawer` primitive in `src/components/ui/drawer.tsx` built on the same `@base-ui/react/dialog` primitives used by the existing `Dialog`. Update `ConnectionForm` to render the form inside `DrawerContent` instead of `DialogContent`. Keep the form body and logic unchanged.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, `@base-ui/react`, `tw-animate-css`, `lucide-react`, Vitest.

## Global Constraints

- No new dependencies; reuse `@base-ui/react` dialog primitives.
- Both new and edit connection flows must use the drawer.
- Drawer width: ~400 px, narrow single-column form layout.
- Keep existing form validation, fields, auth logic, and i18n keys.
- Follow existing `src/components/ui/dialog.tsx` patterns for overlay, portal, close button, and animation attributes.
- Run `pnpm build` and `pnpm test` after changes.

---

## Task 1: Create the `Drawer` UI primitive

**Files:**
- Create: `src/components/ui/drawer.tsx`

**Interfaces:**
- Produces: `Drawer`, `DrawerTrigger`, `DrawerPortal`, `DrawerOverlay`, `DrawerContent`, `DrawerHeader`, `DrawerFooter`, `DrawerTitle`, `DrawerClose` components, matching the `dialog.tsx` API shape.

- [ ] **Step 1: Create `src/components/ui/drawer.tsx` with the drawer primitive**

```tsx
"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useI18n } from "@/hooks/useI18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

function Drawer({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  );
}

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
          "fixed top-0 right-0 z-50 flex h-full w-[400px] max-w-[90vw] flex-col gap-4 border-l border-app-border bg-background p-6 shadow-[var(--shadow-dialog)] outline-none duration-200 ease-out data-open:animate-in data-open:slide-in-from-right-full data-closed:animate-out data-closed:slide-out-to-right-full rounded-l-xl",
          className
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
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-2 pr-8", className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        "mt-auto flex flex-col-reverse gap-2 border-t border-app-border pt-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
```

- [ ] **Step 2: Verify TypeScript compiles for the new file**

Run: `npx tsc --noEmit src/components/ui/drawer.tsx`

Expected: no errors.

- [ ] **Step 3: Commit the new primitive**

```bash
git add src/components/ui/drawer.tsx
git commit -m "feat(ui): add right-edge drawer primitive"
```

---

## Task 2: Migrate `ConnectionForm` from Dialog to Drawer

**Files:**
- Modify: `src/components/workbench/connection-form.tsx`

**Interfaces:**
- Consumes: `Drawer`, `DrawerContent`, `DrawerHeader`, `DrawerTitle`, `DrawerFooter` from `src/components/ui/drawer.tsx`.
- Produces: same `ConnectionFormProps` and `ConnectionForm` export.

- [ ] **Step 1: Replace Dialog imports with Drawer imports**

In `src/components/workbench/connection-form.tsx`, replace:

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
```

with:

```tsx
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
```

- [ ] **Step 2: Swap the Dialog chrome for Drawer chrome**

Replace the entire return statement block in `ConnectionForm`:

Old:

```tsx
return (
  <Dialog open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {initial
            ? t('connection.form.title.edit')
            : t('connection.form.title.new')}
        </DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3 overflow-y-auto p-3 pt-0">
        {/* ... existing form body ... */}
      </div>
      <DialogFooter className="flex flex-row justify-end">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="default" onClick={handleSubmit}>
          {t('common.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
```

New:

```tsx
return (
  <Drawer open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DrawerContent>
      <DrawerHeader>
        <DrawerTitle>
          {initial
            ? t('connection.form.title.edit')
            : t('connection.form.title.new')}
        </DrawerTitle>
      </DrawerHeader>
      <div className="flex flex-col gap-3 overflow-y-auto pr-1">
        {/* ... existing form body ... */}
      </div>
      <DrawerFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="default" onClick={handleSubmit}>
          {t('common.save')}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  </Drawer>
);
```

Leave the form body between the header and footer exactly as-is.

- [ ] **Step 3: Verify the import changes are complete**

Run: `grep -n "Dialog" src/components/workbench/connection-form.tsx`

Expected: no remaining references to `Dialog`.

- [ ] **Step 4: Run typecheck**

Run: `pnpm build` (or `npx tsc --noEmit` if faster)

Expected: no type errors.

- [ ] **Step 5: Commit the migration**

```bash
git add src/components/workbench/connection-form.tsx
git commit -m "feat(workbench): render connection form in right-edge drawer"
```

---

## Task 3: Update tests and verify behavior

**Files:**
- Modify: `src/components/workbench/__tests__/connection-list.test.tsx` (if needed)

**Interfaces:**
- Consumes: `ConnectionForm` rendered inside `ConnectionList` test setup.

- [ ] **Step 1: Inspect the existing test for dialog-specific queries**

Read `src/components/workbench/__tests__/connection-list.test.tsx` and look for any `getByRole('dialog')`, `getByLabelText('Close')`, or similar assertions that assume a dialog.

- [ ] **Step 2: Update queries to match drawer semantics**

If the test asserts on the dialog role, change the role to `dialog` is still correct for a drawer because Base UI `Dialog.Popup` still has `role="dialog"`. However, if the test asserts on the visual centering of a modal, update those expectations to assert that the panel is fixed to the right edge.

Example change if needed:

```tsx
// Old
expect(screen.getByRole('dialog')).toHaveClass('left-[50%]');

// New
expect(screen.getByRole('dialog')).toHaveClass('right-0');
```

If no such assertions exist, no change is needed.

- [ ] **Step 3: Run the workbench tests**

Run: `pnpm test src/components/workbench/__tests__/connection-list.test.tsx`

Expected: all tests pass.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit test updates**

```bash
git add src/components/workbench/__tests__/connection-list.test.tsx
git commit -m "test(workbench): update connection list tests for drawer"
```

---

## Task 4: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run build and test**

Run: `pnpm build && pnpm test`

Expected: `pnpm build` succeeds; `pnpm test` passes.

- [ ] **Step 2: Manual sanity checklist**

- Open the workbench.
- Click **New Connection**: drawer should slide in from the right.
- Click the overlay, press `Escape`, or click the close button: drawer should close.
- Select a connection and click **Edit**: drawer should slide in from the right with the existing values.
- Fill the form and save: profile should be created/updated.

- [ ] **Step 3: Final commit if any additional fixes were required**

```bash
git commit -m "fix: address drawer verification findings" || echo "No additional fixes needed"
```

---

## Self-Review

### Spec coverage

- Replace dialog with drawer for both new and edit flows: Task 2.
- Reusable drawer primitive: Task 1.
- Right-edge placement, 400 px width, single-column: Task 1 (drawer classes).
- Overlay, close triggers, focus trapping, scrolling: Task 1 (uses Base UI Dialog primitive).
- Visual treatment (bg, border, radius, shadow): Task 1.
- Animation: Task 1.
- Accessibility: Task 1 (title semantics, sr-only close label, focus trapping).
- No form logic changes: Task 2 leaves form body unchanged.
- Verification: Task 4.

### Placeholder scan

No TBD, TODO, or vague steps. Each step includes exact file paths, commands, and expected output.

### Type consistency

- `DrawerContent` props match `DialogContent` shape (`showCloseButton?: boolean`).
- `ConnectionFormProps` is unchanged.
- All imports use the exact component names exported by `drawer.tsx`.
