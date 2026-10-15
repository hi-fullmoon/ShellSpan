# Focus workspace

Focus and Terminal have separate workspace views over shared terminal connections.
Each remembers its selected tab, tab order, split tree, split ratios and focused
group. The first Focus visit starts without splits and adopts the current tab;
later visits restore its own view. New connections are available in both views,
while reconnect replacements, status and connection closure propagate to both.
Switching views never creates a connection or disposes its controller. Transient
search, paste confirmation, context menus and drag state do not cross views.
The existing workspace persistence continues to save the Terminal view, even
while Focus is visible. Focus Agent conversations and drafts use their own
workspace keys; Terminal history and automatic restoration exclude Focus sessions.
Focus keeps one Agent conversation on the left and its terminal view on the right.
Hiding the right side does not close connections or dispose controllers.
The right panel has a 40px server header above its standard 32px terminal tabs.
The server header shows the viewed server identity and status, with explicit
Agent target selection and terminal collapse actions. Both panel headers use the
same border token. Target selection is also a tab context-menu action, reachable
with Shift+F10 or the context-menu key. The target tab is marked
with a compact target icon with an accessible label and hover title. The server
header retains the Agent target text badge. The terminal toggle occupies the server header;
when collapsed, an expand action appears in the conversation header.
There is no separate target toolbar or focus page-header row.
Visible command input reopens the right side before the existing lease readiness
and actual xterm focus acknowledgement. Root Agent commands reveal their owning
Terminal or Focus workspace before selecting the execution terminal, preserving
the other view's selection and layout. There is no execution-surface selector.
Terminal creation, search and navigation shortcuts reveal a collapsed terminal
panel, while navigation continues to leave the Agent target unchanged.

Viewing a tab and choosing an Agent target are separate operations. New terminals
use the existing connection dialog and password/key/host-key prompts. Only a
connected terminal can be adopted as the target. Closing or disconnecting it never selects
another host implicitly. Running/waiting tasks, pending submissions, approvals,
questions, and uncertain effects lock target changes.
Connections do not change the Agent target implicitly. Remounting the UI restores the exact
remembered conversation and its draft rather than selecting a recent session.

`agent_runtime_continue_on_target(request)` creates a new root execution Session
with `continuedFromSessionId`. Both the source and destination use
`boundTerminal`. The source must be settled, without queued input or uncertain
native effects; all descendant Sessions must also be settled. The destination must identify a different terminal and
target. Ordinary `agent_runtime_create_session` retains its same-login-only
continuation restriction. The source remains immutable; permissions, tool
effects and approvals are not migrated. The existing redacted conversation
excerpt is background context only. The frontend displays the linked transcripts
in order and obtains authority for the new target through its normal admission
and approval paths.

The initial focus implementation exposes target changes through the tab context
menu. It does not add model-facing application-control tools.

## Validation

Run `node scripts/verify-ai-session-stream.mjs --focus` on a native desktop.
The regression uses real local PTYs and production terminal primitives, checks
view-versus-target selection, keyboard context-menu actions, exact-session
and draft restoration after remount, target badges, collapse/controller retention,
responsive container geometry, equal control heights, keyboard resizing and the
continuation IPC. It does not start a model or connect to a remote host. The
session-store regression also checks cross-login rejection on the ordinary
creation path, visible-only continuation, unchanged source journals, restart
replay and rejection while the source or its descendants have an open turn.
