# Connection Form Drawer

## Status

Design approved; pending implementation plan.

## Goal

Replace the modal `Dialog` used for adding and editing connections with a right-edge `Drawer` that slides in from the right.

## Background

- `src/components/workbench/connection-form.tsx` currently renders a `Dialog` from `src/components/ui/dialog.tsx`.
- The same form is used for both adding a new connection and editing an existing one.
- The application already depends on `@base-ui/react` and has a custom `Dialog` primitive built from those low-level parts.
- A recent visual-refresh spec lists "drawers" alongside dialogs and menus as surfaces to polish.

## Decisions

| Decision | Choice |
|----------|--------|
| Scope | Replace the dialog for **both** new and edit connection flows. |
| Width | Narrow single-column drawer (≈400 px), matching the existing form. |
| Implementation | Add a reusable `Drawer` UI primitive in `src/components/ui/drawer.tsx`. |
| Form body | Keep the existing form structure, validation, and i18n keys. Only the chrome changes. |

## Approaches considered

### A. Reusable `Drawer` UI primitive (selected)

Create a new `drawer.tsx` component built from `@base-ui/react/dialog`, matching the existing `dialog.tsx` architecture. Update `ConnectionForm` to consume the new primitive.

- **Pros:** Consistent with the design-system; reusable for future work; easy to test in isolation; clear separation between dialog and drawer semantics.
- **Cons:** One new file.

### B. Drawer-styled `DialogContent` inside `ConnectionForm`

Keep the current `Dialog` import but override `DialogContent` styles so it appears as a right-edge drawer.

- **Pros:** Smallest file change.
- **Cons:** Mixes dialog and drawer semantics; not reusable; harder to maintain.

### C. Dedicated `ConnectionDrawer` component

Build a one-off drawer in the workbench directory without adding a generic UI primitive.

- **Pros:** Isolated to the workbench.
- **Cons:** Duplicates overlay/popup logic that already exists in `dialog.tsx`; no shared primitive.

## Architecture

### New file: `src/components/ui/drawer.tsx`

Exports the following components, mirroring the API of `dialog.tsx`:

- `Drawer` (root)
- `DrawerTrigger`
- `DrawerPortal`
- `DrawerOverlay`
- `DrawerContent`
- `DrawerHeader`
- `DrawerFooter`
- `DrawerTitle`
- `DrawerClose`

All built from `@base-ui/react/dialog` primitives, with placement and animation tailored to a right-edge drawer.

### Modified file: `src/components/workbench/connection-form.tsx`

- Replace `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` imports with the new `Drawer` equivalents.
- Keep the `ConnectionFormProps` interface unchanged (`open`, `onClose`, `onSubmit`, `initial`).
- Preserve the form body, validation, and `FormRow` helper.
- Only the surrounding chrome and layout classes change.

## Drawer behavior

- **Placement:** fixed to the right edge (`top-0 right-0 h-full`).
- **Width:** `w-[400px]` with `max-w-[90vw]` for very small windows.
- **Overlay:** `fixed inset-0 z-50 bg-black/30 backdrop-blur-sm`, same as `DialogOverlay`.
- **Close triggers:** click the overlay, press `Escape`, or click the close button.
- **Focus trapping:** handled by `DialogPrimitive.Popup`.
- **Scrolling:** form body scrolls inside the drawer; header and footer remain fixed.
- **Backdrop:** clicking the overlay closes the drawer (Base UI default).

## Visual treatment

- Background: `bg-app-surface` / `bg-background`.
- Left border: `border-l border-app-border` to separate the drawer from the main content.
- Radius: `rounded-l-xl`.
- Shadow: reuse `--shadow-dialog` or add a right-leaning shadow token if the visual refresh is in progress.
- Header: `DrawerTitle` on the left, close button on the right.
- Footer: sticky bottom with cancel and save buttons.
- Padding: match the existing dialog padding (e.g., `p-6` for content, `gap-4` for header/footer).

## Animation

Use `data-open` / `data-closed` attributes and Tailwind animations from `tw-animate-css`:

- **Overlay:** `data-open:animate-in data-open:fade-in-0` / `data-closed:animate-out data-closed:fade-out-0`.
- **Panel:** `data-open:animate-in data-open:slide-in-from-right-full` / `data-closed:animate-out data-closed:slide-out-to-right-full` with `duration-200` and `ease-out`.

The exact animation classes may need to be checked against the current Tailwind configuration; fallback to inline CSS transforms if needed.

## Accessibility

- Keep the existing `DialogPrimitive.Title` semantics.
- Close button keeps an `sr-only` label using `t('common.close')`.
- Maintain focus trapping and `Escape` behavior via Base UI primitives.
- Ensure the overlay is not accidentally removed, so screen readers still encounter a modal-like boundary.

## Files to change

| File | Change |
|------|--------|
| `src/components/ui/drawer.tsx` | New reusable drawer primitive. |
| `src/components/workbench/connection-form.tsx` | Swap `Dialog` for `Drawer`. |
| `src/components/workbench/__tests__/connection-list.test.tsx` | Update any dialog-role assertions if the tests interact with the form chrome. |
| `src/locales/en-US.ts` / `src/locales/zh-CN.ts` | Verify no new keys are needed. |

## Out of scope

- No changes to form validation, fields, or auth logic.
- No changes to the connection list, card actions, or deletion flow.
- No new dependency; reuse `@base-ui/react`.

## Verification

After implementation:

- Confirm the drawer opens from the right for both **Add** and **Edit** actions.
- Confirm clicking the overlay, pressing `Escape`, and clicking the close button all close the drawer.
- Confirm the form body scrolls when the window is short.
- Confirm save and cancel buttons work as before.
- Run `pnpm build` and `pnpm test` to catch type or test regressions.
