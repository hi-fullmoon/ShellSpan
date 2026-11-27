# App Control Plane Protocol (Phase 1 & Phase 2)

ShellSpan exposes host-application control capabilities to the Agent Runtime as
synthetic `sessionRuntime` tools (`category: "appControl"` in
`synthetic-tools.json`). They are never dispatched to the native OS-effect tool
executor.

## Synthetic Tools

- `app_inspect`: Read-only, redacted inspection of ShellSpan workspace objects
  (`profiles`, `terminals`, `portForwards`, `sessions`). Never returns
  passwords, private keys, passphrases, API keys, or keychain secrets.
- `app_navigate`: Root-session-only declarative UI navigation (`section`,
  `workbenchTab`, `settings`, `terminal`, `sftpPath`, `hostTool`,
  `agentSession`). Emits `app_action/dispatched` and a durable
  `app_action/card`.
- `app_propose_action`: Root-session-only secret-free form draft proposal
  (`connectionProfile`, `portForward`). Validates and redaction-checks the
  draft before emitting `app_action/proposal_requested`, `app_action/card`, and
  `app_action/dispatched`. Human confirmation in the corresponding UI form is
  required to persist changes.
- `app_terminal`: Root-session-only terminal workspace orchestration
  (`openProfile`, `openLocal`, `focus`). Opening a saved SSH profile always
  routes through ShellSpan's standard interactive credential and host-key flow.
- `app_session`: Root-session-only independent top-level AI session control
  (`create`, `open`, `sendPrompt`). Distinct from `spawn_*_agent` subagents:
  created sessions are peer root sessions with no parent ownership, inherit no
  elevated permissions, remain in the current view by default (rendering a
  clickable "Open session" card unless `focusNewSession: true` is explicitly
  requested), and are rate-limited to 3 creations per turn.

## Invariants

1. **Root-Only UI Focus Lock**: Subagents and Fleet workers cannot call
   `app_navigate`, `app_propose_action`, `app_terminal`, or `app_session` and
   never steal user UI focus.
2. **Replay Safety**: Historical `app_action/dispatched` events loaded on
   session replay or app restart must never re-execute UI navigation or open
   dialogs automatically. Only live events deduplicated by `actionId` execute
   automatically; historical actions remain clickable via `app_action/card`.
3. **Focus Mode Policy**: When `app_navigate` or `app_terminal` targets a view
   outside Focus Mode (such as workbench logs, monitor, SFTP, or settings), the
   frontend automatically exits Focus Mode, performs the navigation, and shows a
   brief toast notice.
4. **Credential Zero-Exposure**: Any draft, prompt, title, or path containing
   redacted secrets is rejected with `APP_ACTION_REDACTION_REQUIRED`.
5. **Session Spawn Guardrail**: `app_session(create)` is capped at 3 new root
   sessions per turn (`APP_ACTION_RATE_LIMITED`) and `sendPrompt` rejects
   self-targeting, subagents, and archived sessions.

## Deep Link Protocol (`shellspan://`, Phase 3)

External callers (shortcuts, launchers, or other tools) can invoke ShellSpan
through validated `shellspan://` URLs:

- `shellspan://open?section=workbench|terminal|sftp&tab=<workbenchTab>`
- `shellspan://settings?section=<settingsSection>`
- `shellspan://terminal/open?profile=<profileId>&dir=<optionalPath>`
- `shellspan://terminal/local`
- `shellspan://sftp/open?profile=<profileId>&path=<path>&side=remote|local`
- `shellspan://agent/open?session=<sessionId>`
- `shellspan://agent/draft?prompt=<encodedPrompt>&profile=<optionalProfileId>`

### Deep-Link Security Invariants

1. **Draft-Only External Prompts**: `shellspan://agent/draft` only opens the AI
   panel and prefills the composer draft for explicit human review. External
   links never auto-submit prompts or auto-execute commands.
2. **Redaction & Length Bounds**: Deep links exceeding 4096 bytes or containing
   redacted credentials are rejected with `DEEP_LINK_REDACTION_REQUIRED`.
3. **Cold-Start Delivery & Deduplication**: Startup arguments and macOS
   `RunEvent::Opened` URLs enqueue into `PendingDeepLinkQueue` and emit
   `shellspan-deep-link`, deduplicated on the frontend by `actionId`.
4. **OS Protocol Registration**:
   - macOS release & dev bundles register `CFBundleURLSchemes = ["shellspan"]`
     via `src-tauri/Info.plist` and `scripts/dev/dev-cargo-runner.mjs`.
   - Windows current-user NSIS installers register and clean up
     `HKCU\Software\Classes\shellspan` via `src-tauri/windows/nsis-hooks.nsh`.
   - Linux `.deb` and `.rpm` packages declare `x-scheme-handler/shellspan` via
     `src-tauri/linux/shellspan.desktop.hbs`.
