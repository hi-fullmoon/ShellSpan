# Compact Connection Drawer Redesign

## Status

Design approved; pending implementation plan.

## Goal

Tighten the "新建连接" / connection-form drawer and fix the four visual issues reported:

1. The drawer overall feels too loose (padding, gaps, spacing).
2. The input focus ring is too prominent.
3. The auth-method select displays the raw key value instead of the translated label.
4. The select height does not match the input height.

## Background

- `src/components/workbench/connection-form.tsx` renders a right-edge `Drawer` from `src/components/ui/drawer.tsx`.
- The form uses `Input` from `src/components/ui/input.tsx` and `Select` from `src/components/ui/select.tsx`.
- The form is shared for both creating a new connection and editing an existing one.
- The current drawer uses `w-[400px] p-6 gap-4`, the input uses `h-9 focus-visible:ring-2`, and the select default trigger uses `h-8 focus-visible:ring-3` and `w-fit`.

## Decisions

| Decision | Choice |
|----------|--------|
| Scope | Redesign the connection-form drawer only; keep the same fields and validation logic. |
| Container | Keep the right-edge drawer; make it narrower and tighter. |
| Design direction | Compact single-column form with denser spacing and aligned controls. |
| Component-level fixes | Apply to `src/components/ui/input.tsx` and `src/components/ui/select.tsx` where the token/height fixes are global; apply layout changes only in `connection-form.tsx`. |
| Select label | Render the translated label explicitly inside `SelectValue` rather than relying on the primitive to infer it. |

## Approaches considered

### A. Minimal fixes (not selected)

Tighten only the four reported issues in place without changing the overall layout or drawer width.

- **Pros:** Smallest change set.
- **Cons:** The form still uses a wide drawer with loose vertical spacing; does not feel like a cohesive redesign.

### B. Compact redesign (selected)

Narrow the drawer, reduce padding and gaps throughout, fix the input/select focus and height, and explicitly render the select label.

- **Pros:** Directly addresses the "too loose" feeling; aligns all controls; reusable fixes for input/select primitives.
- **Cons:** Touches both the form and the shared UI primitives.

### C. Tabbed redesign (not selected)

Split the form into tabs (Basic / Advanced / Jump Host) to reduce visual density per view.

- **Pros:** Less scrolling for long forms.
- **Cons:** Adds navigation friction for a form with only a handful of fields; overkill for the reported issues.

## Detailed design

### Drawer container (`src/components/ui/drawer.tsx` and `connection-form.tsx`)

- **Width:** `w-[360px]` (down from `w-[400px]`).
- **Content padding:** `p-4` (down from `p-6`).
- **Content gap:** `gap-2` (down from `gap-4`).
- **Header:** keep `DrawerTitle` left-aligned, close button right-aligned; reduce right padding to `pr-6`.
- **Footer:** `pt-3 gap-2` (down from `pt-4 gap-2`), keep `border-t`.

### Form layout (`connection-form.tsx`)

- `FormRow` internal gap: `gap-0.5` (down from `gap-1`).
- Field order remains the same:
  - Name (full width).
  - Host (2/3) + Port (1/3) grid.
  - Username (full width).
  - Auth method (full width).
  - Password or private-key fields (full width).
  - Jump-host checkbox.
  - Jump-host collapsible box: `p-2.5 gap-2` with `rounded-lg border border-app-border bg-muted`.

### Input primitive (`src/components/ui/input.tsx`)

- Keep `h-9` and `px-3 py-1`.
- Reduce focus ring from `focus-visible:ring-2` to `focus-visible:ring-1 focus-visible:ring-ring`.
- Keep the existing border and radius.

### Select primitive (`src/components/ui/select.tsx`)

- Change default trigger height from `h-8` to `h-9` to match input.
- Change width from `w-fit` to `w-full` so it fills the form row.
- Match input padding: `px-3 py-1` (adjust from `py-2 pr-2 pl-2.5`).
- Reduce focus ring from `focus-visible:ring-3` to `focus-visible:ring-1`.
- Keep radius as `rounded-lg` (or align to `rounded-md` if the design system prefers; the existing input uses `rounded-md`).

### Select label rendering (`connection-form.tsx`)

- In the two auth-method selects (main and jump host), render the translated label explicitly inside `SelectValue`:

```tsx
const authMethodLabel =
  form.authMethod === 'key'
    ? t('connection.form.auth.key')
    : t('connection.form.auth.password');

// ...
<SelectValue>{authMethodLabel}</SelectValue>
```

This ensures the select never shows the raw key `password` or `key`.

## Files to change

| File | Change |
|------|--------|
| `src/components/ui/drawer.tsx` | Narrow to `w-[360px]`, reduce content padding/gap. |
| `src/components/ui/input.tsx` | Reduce focus ring to `ring-1`. |
| `src/components/ui/select.tsx` | Set default height to `h-9`, width to `w-full`, match input padding, reduce focus ring. |
| `src/components/workbench/connection-form.tsx` | Tighten `FormRow`, drawer layout, and explicit `SelectValue` labels. |
| `src/components/workbench/__tests__/connection-form.test.tsx` | Update any snapshot/class assertions if tests assert on padding/height. |

## Out of scope

- No changes to form validation, fields, or auth logic.
- No changes to the connection list, card actions, or deletion flow.
- No new dependency.

## Verification

After implementation:

- Open the drawer for both **Add** and **Edit** actions; confirm it is narrower and tighter.
- Confirm input focus shows a subtle `ring-1` shadow, not a heavy ring.
- Confirm the auth-method select displays the translated label (e.g., "密码" / "私钥") and not the raw value.
- Confirm the select height equals the input height (36 px).
- Confirm the form still scrolls when the viewport is short.
- Confirm save and cancel buttons work as before.
- Run `pnpm build` and `pnpm test` to catch type or test regressions.
