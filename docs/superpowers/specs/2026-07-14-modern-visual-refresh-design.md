# TermBridge Modern Visual Refresh

## Status

Design approved; pending implementation plan.

## Goal

Refresh the overall visual style of TermBridge so it feels modern, clean, and premium without changing layouts or feature behavior.

## Direction

**Approach: full surface polish, no layout changes.**

Keep all existing component structure, page layouts, and interactions. Update every visible surface to match a current SaaS desktop aesthetic: calm hierarchy, generous whitespace, crisp edges, and a single vivid accent against warm gray neutrals.

### Design principles

- One clear accent color for actions and active states.
- Avoid heavy borders; use tinted backgrounds and subtle shadows to separate regions.
- Use a consistent spacing scale and border radius across all surfaces.
- Add subtle hover, focus, and active transitions for tactile feedback.

## Color system

### Warm gray neutrals

| Token | Light | Dark |
|-------|-------|------|
| Background (`--app-bg`) | `#fafaf9` warm gray 50 | `#0c0a09` warm gray 950 |
| Surface (`--app-surface`) | `#ffffff` | `#1c1917` |
| Surface muted (`--app-surface-muted`) | `#f5f5f4` | `#292524` |
| Border (`--app-border`) | `#e7e5e4` | `#44403c` |
| Text (`--app-text`) | `#1c1917` | `#fafaf9` |
| Text soft (`--app-text-soft`) | `#78716c` | `#a8a29e` |

### Vivid accent

| Token | Light | Dark |
|-------|-------|------|
| Primary (`--app-primary`) | `#0d9488` teal 600 | `#2dd4bf` teal 400 |
| Primary text (`--app-primary-text`) | `#ffffff` | `#0c0a09` |
| Primary subtle background | `#ccfbf1` | `#115e59` |
| Error (`--app-error`) | `#dc2626` | `#ef4444` |
| Warning (`--app-warning`) | `#d97706` | `#f59e0b` |
| Success (`--app-success`) | `#16a34a` | `#22c55e` |

## Typography and spacing

- Keep the existing typeface: Geist Variable.
- Tighten the type scale.
- Base: 13px, line-height 1.5.
- Headings: 14–16px semibold, tracking tight.
- Spacing base: 4px.
- Main gaps: 12–16px.
- Card padding: 16px.
- Border radius: 10px for cards and panels, 6px for buttons and inputs, 999px for pills and active nav items.

## Surfaces to polish

Update the visual treatment of these components while keeping their layout and behavior:

- **App chrome**: title bar, sidebar, section navigation.
- **Cards**: connection cards, SFTP file list rows, and any other card-like surfaces.
- **Buttons and inputs**: radius, padding, disabled/loading states, focus rings.
- **Empty states**: refined icon and calmer copy color.
- **Dialogs, drawers, and menus**: softer overlay backdrop, tighter headers, consistent padding.
- **Terminal and SFTP chrome**: tabs, toolbars, breadcrumbs, and status bars.

## Out of scope

- No layout restructuring.
- No new features or workflows.
- No icon library change; continue using Lucide icons.
- No heavy motion or animation beyond subtle hover/focus transitions.

## Verification

After implementation:

- Confirm both light and dark themes render correctly.
- Confirm no layout shifts or broken component behavior.
- Run `pnpm build` and `pnpm test` to catch type or test regressions.
