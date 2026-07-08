# Terminal Panel Refactor Design (Spec 1)

## Overview

Refactor the terminal panel into a VSCode-style tabbed experience where switching tabs preserves full terminal state (scrollback buffer, cursor, running output) and the SSH connection stays continuously alive in the background. Introduce a terminal controller registry that owns persistent xterm instances decoupled from React rendering, so tab switches reparent DOM nodes instead of disposing/recreating terminals. Spec 1 covers the registry architecture, core tab UX, inline profile picker, drag-to-reorder, and a tab context menu. Split terminal pane is deferred to Spec 2.

## Goals

- **State preservation across tab switches.** Switching the active terminal tab never disposes the xterm instance, never tears down SSH listeners, and never loses buffered output. Background tabs keep streaming into their xterm buffer.
- **VSCode-style tab bar.** Bottom-border active indicator, hover-revealed close button, error badge, horizontal overflow scroll, valid HTML structure.
- **Inline profile picker.** The `+` button opens a dropdown of saved connection profiles directly in the terminal panel; selecting one starts a new session without navigating to the Workbench.
- **Drag-to-reorder tabs.** Tabs can be reordered via drag using `@dnd-kit`; the active tab stays active by id.
- **Tab context menu.** Right-click exposes Rename, Duplicate, Copy connection info, Close, Close Others, Close to the Right.
- **Shared connect flow.** Extract the connect + host-key-dialog logic from `Workbench` into a reusable hook so Workbench, the picker, and the Duplicate action share one path.
- **Testable store.** `terminalStore` stays pure (no registry import); new actions are unit-tested.

## Non-Goals

- Split terminal pane (Spec 2).
- Inline "new connection" form in the picker (picker only connects existing profiles).
- Persisting tab order or restoring tabs across app restarts.
- Fancy tab overflow scroll arrows (basic `overflow-x-auto` suffices for now).
- Changing the top-level section switching model in `App.tsx` (Workbench/Terminal/Sftp already use the `hidden` keep-alive pattern; unchanged).

## Architecture

### Terminal controller registry (new, non-React)

`src/components/Terminal/registry/terminalRegistry.ts` — a singleton owning the stateful xterm resources, decoupled from React rendering so tab switches never destroy a terminal.

```ts
interface TerminalController {
  sessionId: string;
  terminal: Terminal;            // xterm instance, created once
  fitAddon, searchAddon;         // addons
  container: HTMLDivElement;     // persistent DOM node owned by the controller
  host: HTMLElement | null;      // current parent pane (null when parked)
  resizeObserver: ResizeObserver;
  unlisten: { data, status, closed };
  attach(host: HTMLElement): void;  // host.appendChild(container); fit(); ensure observer
  detach(): void;                   // disconnect observer; container stays referenced (parked)
  write(chunk: string): void;
  dispose(): void;                 // unlisten + terminal.dispose + remove container
}
```

**Lifecycle:**
- Created when a session is added. Sets up listeners:
  - `ssh-data` → `terminal.write(chunk)`. xterm buffers output before first `open()`, so even parked (never-attached) sessions accumulate output.
  - `ssh-status` → `terminalStore.setStatus`.
  - `ssh-closed` → `terminalStore.setClosed`.
- `attach(host)`: `host.appendChild(container)`, calls `fit()`, starts observing. Re-parenting an already-opened xterm works — its `.xterm` element moves with the container; re-fit on size change.
- `detach()`: disconnect observer. Container stays referenced by the controller (detached from DOM), terminal alive, buffer intact.
- `dispose()`: full teardown — unlisten all, `terminal.dispose()`, remove container from any parent. Called by the `TerminalControllerLayer` when it detects a session left the store (see Lifecycle binding below), alongside `removeSession` + `invokeCloseSession` invoked by the tab/UI layer.
- ResizeObserver callback skips `fit` when `container.offsetParent === null` (parked/hidden) to avoid collapsing to 0 cols.

### Store changes (`terminalStore.ts`)

```ts
interface TerminalSession {
  ...existing fields...;
  profileId?: string;   // NEW — enables Duplicate and context menu
}

interface TerminalState {
  ...existing...;
  reorderSessions: (activeId: string, overId: string) => void;  // NEW
}
```

- `addSession(summary, profileId?)` — also persists `profileId` (optional arg).
- `reorderSessions(activeId, overId)` — reorders the `sessions` array, moving the `activeId` session to the position of `overId`. The active tab stays active by id.
- Existing `removeSession`, `setActiveSession`, `setStatus`, `setClosed`, `updateTitle` unchanged.

The store stays pure and testable (no registry import). Lifecycle is centralized in the component layer:

- **Tab/UI close handler** (in `TerminalTabBar` and context menu) calls only `removeSession(id)` + `invokeCloseSession(id)`. It does **not** touch the registry directly.
- **`TerminalControllerLayer`** subscribes to the `sessions` array and reconciles: for any `sessionId` present in the store but missing a controller, it `registry.create`s one; for any controller whose `sessionId` left the store, it `registry.dispose`s it. This keeps store/registry in sync from a single source of truth and avoids callers needing to know about the registry.

### Why registry + reparenting (chosen approach)

- Top-level sections (Workbench/Terminal/Sftp) already keep state via `hidden` in `App.tsx:82-105`. But within Terminal, only the active `TerminalSession` is currently rendered (`Terminal/index.tsx:26`), so inactive xterm instances are disposed (`useTerminalSession.ts:101-110`), destroying the buffer and tearing down listeners.
- Approach A (render-all + `hidden`) is simpler but does not compose with split panes (moving a terminal between panes unmounts/remounts it, losing state) — it would force DOM reparenting anyway.
- Approach B (registry + reparenting) keeps xterm fully alive across tab switches and naturally supports split panes (a pane hosts any session's container by appending it). Chosen.

## Component Structure

```
src/components/Terminal/
  index.tsx                      (rewritten — thin shell)
  TerminalPane.tsx               (NEW — hosts active controller's container)
  TerminalTabBar.tsx             (rewritten — VSCode-style tabs + drag + context menu)
  NewTabMenu.tsx                 (NEW — inline profile picker dropdown)
  TerminalControllerLayer.tsx    (NEW — bridges store ↔ registry, lifecycle owner)
  TerminalContextMenu.tsx        (NEW — right-click menu)
  registry/
    terminalRegistry.ts          (NEW — singleton controllers)
    terminalRegistry.test.ts     (NEW)
  hooks/
    useActiveController.ts       (NEW — attach/detach the active controller to a pane ref)
src/hooks/
  useConnectSession.ts           (NEW — shared connect + host-key dialog flow)
```

### Responsibility split

- **`terminalRegistry.ts`** — stateful, imperative. Owns xterm. No React.
- **`TerminalControllerLayer.tsx`** — React component owning the lifecycle binding. Rendered once inside `index.tsx`, above the pane, renders nothing visible. Subscribes to the `sessions` array and reconciles: creates a controller for any new `sessionId`, disposes controllers whose session left the store (single source of truth for lifecycle; callers only mutate the store).
- **`TerminalPane.tsx`** — a `<div ref>` host. `useActiveController` attaches the active session's controller container into it; on active-id change it detaches the old and attaches the new (reparenting, no dispose).
- **`TerminalTabBar.tsx`** — pure UI: reads store, renders tabs. Dispatches `setActiveSession`, `removeSession`, `reorderSessions`, opens context menu, toggles `NewTabMenu`.
- **`NewTabMenu.tsx`** — dropdown of saved profiles; clicking one calls `useConnectSession`.
- **`TerminalContextMenu.tsx`** — positioned menu rendered on right-click.
- **`index.tsx`** — composes `<TerminalControllerLayer /><TerminalTabBar /><TerminalPane />` plus the empty state when no sessions exist.

## Layout (VSCode-like)

```
┌─────────────────────────────────────────────┐
│ [Tab1 x][Tab2 x][Tab3 x]        [+] [split]│  ← TerminalTabBar (h-9)
├─────────────────────────────────────────────┤
│                                             │
│              active terminal                │  ← TerminalPane (flex-1)
│                                             │
└─────────────────────────────────────────────┘
```

- Tab bar height `h-9`; tabs `h-7`, min width, `max-w-44`.
- Left: tabs (horizontal scroll when overflow via `overflow-x-auto`, hidden scrollbar).
- Right: `+` (new) and `split` icon. The `split` icon is hidden/disabled in Spec 1 (lands in Spec 2).
- Pane padding `p-2` moves into `TerminalPane` so the reparented container fills cleanly.

## Tab UX

### Tab styling
- **Active:** bottom 2px `app-primary` border indicator (not full background fill — cleaner, matches VSCode), `text-app-text`.
- **Inactive:** `text-app-text-soft`, hover → `bg-app-surface/50`, text brightens.
- **Error badge:** `1.5w` red dot, moved to the left of the title.
- **Close `×`:** appears on hover (or always if active), `h-4 w-4`, `hover:bg-app-border`. The close is a sibling button with `e.stopPropagation`, fixing the current invalid `<span onClick>` inside `<button>`.

### Overflow
When tabs exceed bar width: `overflow-x-auto` with hidden scrollbar. Wheel/drag scrolls horizontally. Fancy scroll arrows are out of scope for Spec 1.

## Drag-to-reorder

Using `@dnd-kit/core` + `@dnd-kit/sortable` (already in `package.json`). Tabs are `SortableContext` items keyed by `sessionId`. On `onDragEnd`, if `active.id !== over.id`, call `reorderSessions(active.id, over.id)`. The active tab stays active by id. dnd-kit handles transforms; store update snaps to final order with no layout shift jank.

## Inline Profile Picker (NewTabMenu)

- `+` button toggles a dropdown anchored below it.
- Lists saved profiles from `profileStore`; each row shows name + `user@host`.
- Selecting a profile runs the shared connect helper (`useConnectSession`).
- If no profiles exist, the dropdown shows a hint linking to the Workbench section.
- No inline "new connection" form in the picker (out of scope).

## Shared Connect Helper

Extract `connectTerminal` logic from `Workbench/index.tsx:84-97` and the host-key error handling from `113-161` into `src/hooks/useConnectSession.ts`. The hook returns a `connect(profile)` function **and** host-key dialog state; the caller renders the dialog:

```ts
export function useConnectSession(): {
  connect: (profile: ConnectionProfile) => Promise<void>;
  hostKeyDialog: { open: boolean; host: string; port: number; fingerprint?: string; mismatch: boolean; onTrust: () => void };
  closeHostKeyDialog: () => void;
};
```

- `connect` ensures password, calls `invokeCreateSession` with `buildSessionCreateRequest(profile, 120, 30)`, then `addSession(summary, profile.id)`.
- On a host-key error (`HostKeyUnknown` / `HostKeyMismatch`), `connect` populates `hostKeyDialog` state (held inside the hook via `useState`) and awaits the user's trust decision; on trust it calls `invokeTrustHost` and retries `connect`. The caller renders a single `<HostKeyDialog>` bound to that state.
- `Workbench`, `NewTabMenu`, and the Duplicate context-menu action all call this hook and render its dialog, so there is one connect path and one host-key dialog implementation. This is targeted cleanup directly serving the goal (multiple connect entry points).

## Tab Context Menu

Right-click a tab opens a positioned menu (`TerminalContextMenu.tsx`) with items:

- **Rename** — prompts for new title → `updateTitle`.
- **Duplicate** — if `profileId` present, calls `useConnectSession(profile)`.
- **Copy connection info** — writes `user@host:port` to clipboard.
- Separator.
- **Close** — single session.
- **Close Others** — closes all but this.
- **Close to the Right** — closes tabs to the right of this.

Close-others/right iterate calling the same close handler per session.

## Testing

- **`terminalStore.test.ts`** — extend with: `reorderSessions` reorders correctly; `addSession` with `profileId` persists it; `removeSession` cleans active when removing the last of a close-others batch.
- **`terminalRegistry.test.ts`** (jsdom) — create controller attaches a container to a host; `write` appends to xterm buffer (read `terminal.buffer.active.length`); detach leaves buffer intact; attach to a different host preserves buffer length; dispose unregisters. Mock `listen`/`invoke` via `vi` mocks.
- **`TerminalTabBar` test** — render with sessions; click tab calls `setActiveSession`; close button calls handler and stops propagation; right-click opens menu.
- **`NewTabMenu` test** — profiles render; selecting calls `useConnectSession`.
- Existing `useTerminalSession` is replaced by the registry; its behavior is covered by registry tests.

Run via `pnpm test` (vitest). Typecheck via `pnpm build` (`tsc && vite build`). No lint script in `package.json`.

## Out of Scope (Spec 2 / later)

- Split terminal pane (Spec 2, built on this registry).
- Tab overflow scroll arrows (basic `overflow-x-auto` for now).
- Inline "new connection" form in the picker.
- Persisting tab order / reopening tabs across app restarts.

## Migration

- `useTerminalSession` (hook) is removed; its responsibilities move to `terminalRegistry` + `useActiveController`.
- `TerminalSession.tsx` (search bar + connecting overlay) is reworked: the search UI now drives the active controller's `searchAddon` via `useActiveController`; the connecting overlay reads the active session's status from the store.
- `TerminalTabBar.tsx` is rewritten (structure above).
- `Terminal/index.tsx` is rewritten (thin shell).
- `Workbench/connectTerminal` and its host-key handling are replaced by `useConnectSession`.
- `terminalStore` gains `profileId` and `reorderSessions`; existing tests are extended, not broken.
