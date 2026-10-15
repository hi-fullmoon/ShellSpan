# Focus workspace

Focus is an application layout over the existing terminal workspace. It keeps
one Agent conversation on the left and the existing terminal tabs/splits on the
right. Hiding the right side does not close connections or dispose controllers.
Terminal tabs are the right panel header. Both panel headers stay 40px high and
use the same border token. Target selection is an explicit tab context-menu action,
also reachable with Shift+F10 or the context-menu key. The target tab is marked
with an Agent target badge. The terminal toggle remains in the application
titlebar. There is no separate target toolbar or focus page-header row.
Visible command input reopens the right side before the existing lease readiness
and actual xterm focus acknowledgement. There is no execution-surface selector.
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
