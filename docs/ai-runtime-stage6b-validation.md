# Stage 6B validation — 2026-09-04

Status: implementation and the macOS/isolated Linux fixture gates pass. This is
not an all-platform acceptance: Windows execution/junction validation has not
run, and Stage 7, external live providers, main integration and 6C/6D are outside
this delivery. Do not silently convert those unverified items into PASS.

## Environment and migration integrity

- Worktree `/Users/zhengbiwen/.codex/worktrees/5d5b/ShellSpan`, macOS arm64;
  Node `24.15.0`, pnpm `11.1.1`, Rust `1.95.0`.
- Frozen 6A source: `/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan`, HEAD
  `25af899f9cde2c5da039e3f76c652b173334e6ea`.
- Verified its tracked patch SHA-256
  `6ddb4b860e46b602309a18bf87141127fe6214473f41b86e06f66ff9c601e7f8`,
  applied with `git apply --check`, copied all 13 untracked product files and
  delivery metadata, then verified all 89 cumulative source hashes before edits.
- Coordinator required preserving new main commit
  `1ac0c1e4a070bd8024063af5c58e4b2add3b7395`. Its independent projection change was
  applied cleanly and retained; detached HEAD now identifies that base. The
  conversation projection is intentionally a merged source, not byte-identical
  to the old 6A projection. No commit, merge, push or main-checkout write occurred.
- Harness remained read-only. The 6A source was not edited; only its Rust target
  build cache was reused with a command-scoped `CARGO_TARGET_DIR`.
- Docker Linux fixture uses a disposable named project, loopback ports 22222/22223,
  fixture-only credentials and isolated known-hosts/DB state. The runner removes
  its own containers and volumes. Python 3 was added to the fixture image for
  the same fixed remote handle program used by production.
- The isolated worktree did not run external live providers. The coordinator
  confirmed the same ShellSpan main workspace has `.env.local`; final live
  validation is reserved for Stage 7. No secret values or other-project
  credentials were read or copied. This stage makes no claim that the whole
  project lacks configuration.

## Required behavior matrix

All Rust test names below are in the `skill_` gate unless otherwise noted.

| Group | Evidence and boundary |
| --- | --- |
| Real discovery | `skill_real_local_discovery_duplicates_shadcn_and_shallow_scope`: flat, bundle, actual repository shadcn metadata, nested exclusion, deterministic duplicate winner and diagnostic |
| YAML/policy | Four-combination/default tests; ambiguous booleans, legacy aliases, duplicate/type/document errors, inert unknown metadata, CRLF and multiline description tests |
| Real provider wire | `skill_real_runtime_http_wire_catalog_slash_and_model_tool_body`: real Runtime/local provider/OpenAI-compatible HTTP adapter; received catalogue, user-only slash body, model-only tool body, tail and provenance |
| Actual user consumer | `test:ai:stage6b:controller`: production controller → adapter → IPC payload wrappers → test-only IPC transport → real Rust Runtime/Session/local provider → real HTTP receiver. Menu and manual input use distinct terminal targets, explicit root creation, no model on listing, exact whitespace, enqueued/claimed IDs, one complete invocation per session and complete wire body. Transport substitutes the desktop channel, not the runtime behavior |
| Refresh/retirement | Runtime refresh test plus local empty/rebuild/root tests; body-only/policy-only unchanged model summaries, deletion/rename/current-winner changes; `skill_incomplete_preserves_last_good_but_revocation_retires_list_and_model_catalog` |
| Incomplete | Controlled listing/read/permission/second-enumeration/deadline failures; oversized files, candidate/winner/8 MiB total limits; no partial replacement. Retirement followed by incomplete remains retired |
| Execution recheck | Real files edited after listing: model/user policy revoked, disabled duplicate winner, deletion/rename, current scope failure; stale catalogue does not authorize loading |
| Slash and ingress | Unicode whitespace/exact token/source tests; actual Inbox claim test and Form exclusion; replay retains the outcome when a name was unknown; controller preserves original text |
| Bounds/integrity | File and UTF-8 rendered limit−1/exact/+1; XML-wrapper expansion; complete batch bound; serialized observation/payload guard; directory/total limits; redaction mismatch rejects complete body. Output above ordinary 8 KiB reaches the provider intact |
| Crash/replay | Every complete JSONL prefix from claim intent through first RequestHeader, including partial trailing line; every model call prefix through StepEnd; committed original bytes survive file edits and restarts |
| Compaction/inheritance | Actual compaction followed by catalogue republish, including retired empty catalogue; immutable historic hash facts. Real safe-prefix child request excludes saved parent instructions and fresh child tool calls consume the original budget. Cross-target loads return their own bodies; cumulative capability rejection tests remain passing |
| Local/remote safety | Controlled local root/component replacement and fixed-helper no-follow open races; path-bound checks; remote target with a local decoy never falls back. Real isolated production SFTP/SSH provider verifies normal root file changes do not drift, refresh/delete/symlink/root/profile drift. Windows branch is implemented but native compilation/execution and junction tests are **not run** here |
| Budget/cancel/authority | Oversized post-load input sends zero model requests; controlled held read must be joined before idle and commits no loaded body after cancellation; stalled SSH handshake cancellation/deadline and owned bridge-worker join tests. Successful skill barrier follows two drained reads; subsequent write waits for ordinary approval. Before/after/failure hooks and real child admission tests pass |
| UI/protocol | Two projections from real Runtime JSON, exact Session-only list IPC, cold creation, old target response/failure isolation, explicit root prompt, menu/keyboard/Chinese feedback and old metadata. 8 Chromium layouts use one MessageScroller and preserve the inserted slash. Question resume retains original Skills preparation; form answer `/name` never loads a skill |

Windows is a remaining platform verification item in the local/remote safety
row, not covered by the Unix race tests. No Windows PASS is claimed.

## Commands and outcomes

Rust commands inherited:
`CARGO_TARGET_DIR=/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan/src-tauri/target`.
Logs are non-product local evidence under `/tmp/shellspan-stage6b-*.log`.

| Command | Outcome |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS, no dependency/lockfile upgrade |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm test:ai:stage6b` | PASS: 32 focused Rust tests; 44 frontend tests; one frontend + one Rust real controller bridge test; one explicitly executed isolated SFTP test; 8 Chromium scenes. The two ignored entries in the initial Rust filter are explicitly executed later by this gate |
| `pnpm test:ai:stage6a` | PASS: 40 frontend; 17 Rust (includes Skills/question interop); 8 question Chromium scenes |
| `pnpm test:ai:stage3` | PASS: 79 frontend; Rust filters 21 + 226 passed / 11 ignored |
| `pnpm test:ai:stage4` | PASS: 54 frontend; Rust filters 3 + 23 + 17 passed / 9 ignored |
| `pnpm test:ai:stage3b` | PASS: 57 frontend; Rust filters 87 + 6 + 1 + 17 passed / 1 ignored |
| `pnpm test:ai:stage5` | PASS: 18 scheduler; remaining filters 1 + 2 + 2 + 1 + 9 passed / 1 ignored |
| `pnpm test` | PASS: 1445 tests / 169 files; one process-bridge test skipped in the ordinary run and explicitly passed by its runner |
| `pnpm build` | PASS; existing >500 kB bundle advisory remains |
| `pnpm test:scripts` | PASS: 29 tests / 6 files |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --no-fail-fast` | PASS: 575 passed / 23 ignored; no failures |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS |
| `rustfmt --edition 2021 --check src-tauri/src/agent_runtime/skill_tests.rs src-tauri/src/agent_runtime/skill_bridge_tests.rs src-tauri/src/agent_runtime/question_tests.rs` | PASS |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | PASS |
| `git diff --check` | PASS |
| External live / Windows runtime | NOT RUN; no PASS inferred |

The final Rust lib, fmt and Clippy runs include the last catalogue XML-escaping
and retired-catalogue-after-compaction changes. The earlier cumulative gate runs
are retained individually; the final all-lib run again passed 575 tests.

Browser evidence:
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-skills-visual-ZooFCo`.
Widths 320/400/560/720, light/en-US and dark/zh-CN, reduced motion. Root and menu
screenshots were inspected; project entry is editable, menu fits the viewport,
no horizontal menu overflow, one MessageScroller, ordinary draft plus `/user `.
Question regression evidence is under
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-question-visual-jUs2d0`.
No pixel baseline was overwritten.

The fixed-helper program was additionally exercised with a controlled root/file
symlink substitution immediately before its `os.open`. This complements the
real remote fixture; it does not substitute an in-memory provider for it.

## Fixes found during validation

- Root identity initially included mutable directory attributes; normal business
  file changes now preserve identity. Pathname pre/post checks were replaced by
  no-follow handle traversal for local and remote Skills reads.
- Claim-prefix repair and Skill queue restoration now preserve the original
  durable step; complete results are replayed without re-reading edited files.
- Cold Session creation initially had no project root. Explicit root selection
  now freezes it through the normal create route. Portal input clicks previously
  bubbled to the composer's click-to-focus addon and put directory text into the
  draft; the project dialog isolates that click and the full bridge proves it.
- Old target creation failures are identity-guarded before clearing root state.
- Complete payload JSON size and original-text whitespace are now checked along
  the actual consumer path. Step input was calibrated to 112 KiB.
- Retirement survives later incomplete observations and compaction. Scoped
  socket cleanup also joins owned jump bridge workers.
- Strict tool-catalog expectation includes `skill`; no blanket limit increase or
  shadcn SDK/zod dependency workaround was introduced.

## Frozen delivery

Run `node scripts/ai-runtime-stage6b-handoff.mjs` after any source/document edit.
The inventory records HEAD, migration provenance, complete tracked patches, all
untracked product files (including the Python helper and real Runtime fixture),
SHA-256 for the deduplicated cumulative sources, and delivery metadata hashes.
The previous frozen 6A delivery metadata is preserved as historical evidence.
Dependencies, build output, target, transient logs/screenshots and credentials
are excluded. Patches alone are insufficient: copy every listed untracked file
and verify the cumulative source hashes. No index or ref is changed by the
handoff generator.

The frozen inventory contains 119 cumulative source files, including 35 untracked
product files. Both tracked patches were checked and applied to separate temporary
trees exported from their exact bases (`1ac0c1e4` and `4f353d9`); after copying the
listed untracked products, both reconstructions matched all 119 source SHA-256
values. The original 6A source still matched all 89 frozen source hashes and its
patch hashes. Verification used only disposable temporary directories; no main
index/ref or source worktree was changed.
