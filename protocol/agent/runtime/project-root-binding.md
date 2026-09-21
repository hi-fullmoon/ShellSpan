# Project directory binding

`agent_runtime_bind_project_root` accepts `{ input: { sessionId, root } }` and
returns the committed Session snapshot. It adds a directory to an existing
Session without replacing its ID, messages, terminal identity or permissions.

Binding is allowed only for an idle, unarchived root Session with an empty
inbox, no pending recovery and no active driver operation or terminal lease.
The existing directory must be absent. Already bound directories cannot change.
The root must be absolute and contain no control characters. Local roots use
platform path semantics; remote roots use POSIX absolute paths. Existing scoped
readers validate directory access and identity when files are listed or read.

The append-only v5 event `session/project_root_bound`, with `data: { root }`,
sets `target.cwd` for local targets or `target.rootPath` for remote targets.
Replay preserves the binding. Clients predating this event cannot read newly
bound Session logs. The chooser remains available when listing reports
`RootRequired`; successful binding refreshes the snapshot before listing files.
