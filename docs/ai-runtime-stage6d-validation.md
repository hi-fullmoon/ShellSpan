# Stage 6D validation — 2026-09-04

Accepted scope: macOS arm64 implementation, real local directory trees, isolated
Linux SSH fixtures and Chromium UI/HTTP receiver. Windows native compilation and
junction execution, external live providers, final main integration and Stage 7
are **NOT RUN / PENDING**. This stage does not complete the overall goal.

## Behavior evidence

| Boundary | Evidence |
| --- | --- |
| Session binding | Explicit cwd/rootPath via shared 6B entry; new and restored Session paths; cold root not inferred; image selection creates no rootless Session |
| Path grammar | Start/whitespace @, email exclusion, caret in token, whole-token replacement, preserved prefix/suffix, quoted spaces and open directory quote, invalid names rejected |
| Keyboard/IME | Up/down/Enter/Tab/Escape, pointer, composition events/key229; no submit while listing/empty/error; Tab can leave; Enter opens cold root dialog |
| Portal/focus | Actual browser click and sequential root input; root form receives all characters and main draft remains unchanged; dialog independent of composer focus and no empty addon |
| Ownership | AbortSignal wrapper sends Session + UUID cancel only; pre-abort dispatches nothing; local/native in-flight cancellation; dropped operation RAII; stale response/error/finally and A→B→A controller/composer tests |
| Native bounds | Actual tree refresh, empty vs absent vs permission denial, 40-result truncation, 1024-entry refusal, component/path limits, deadline, four-worker admission |
| No content reads | Discovery's read method is forbidden by a sentinel; real file content sentinel absent from all received HTTP and journal data; remote unreadable file still listed; no ToolCall from completion |
| Local confinement | Shared no-follow traversal and root/component swap regressions; links and unrepresentable names excluded; root listing uses independent directory cursor |
| Persistent identity | File scope survives Runtime restart and rejects root replacement; Skills and file discovery share the same identity, including Skills-first/file-first |
| Remote production provider | Actual SSH/SFTP/profile/credential/known-host path, space directories, file chmod 000, empty/absent/denied, invalid paths, symlink escape, Linux non-UTF8 filename, truncation, cancellation and profile/root drift |
| Remote dependency failure | Second disposable-fixture run removes Python 3; production lookup reports Unavailable, with no local fallback |
| Actual submit | Production composer/controller/adapter/Tauri payload wrappers → Rust Session/provider → loopback HTTP; six image/skill/file permutations and text-only; exact ordinary prompt retained |
| Recovery | Real Runtime restart and browser reload; existing target is reused; idle text-only follow-up attaches before enqueue; retained image bytes still verified by shared bridge |
| Projection/layout | Both cumulative projection suites, request/start and prompt snapshot tests; one MessageScroller; 320/400/560/720 × light/en-US + dark/zh-CN; no page horizontal overflow |

The browser runner substitutes only the desktop transport. It decodes the same IPC
input types and delegates to actual Runtime services; committed Rust events are
forwarded into the frontend subscription. The loopback model returns deterministic
SSE, so this is neither external live evidence nor native desktop binary testing.

The normal native file-reference filter has 7 passing cases and 2 ignored bridges.
The aggregate gate explicitly executes the SSH bridge twice (normal/missing Python)
and the real browser bridge once, covering 8 scenes. The broader ordinary Rust
ignored count includes earlier external/fixture cases; no skipped case is called
PASS without its explicit runner.

## Commands and outcomes

Environment: Node 24.15.0, pnpm 11.1.1, Rust 1.95.0, macOS arm64.
Rust cache only:
`CARGO_TARGET_DIR=/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan/src-tauri/target`.
No global toolchain change, lock upgrade, source-worktree edit or credential copy.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS during reception; lock/workspace retained |
| `pnpm test:ai:stage6d` | 7 native + 51 frontend + SSH 1 normal/1 missing-Python + real bridge/8 browser scenes PASS |
| `pnpm test` | 1490 passed, 1 skipped; 174 passed files/1 skipped |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm build` | PASS; existing large-bundle advisory only |
| `pnpm test:scripts` | 29 passed |
| Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --no-fail-fast` | 598 passed, 26 ignored |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS |
| Explicit include-file rustfmt (file_reference_tests, file_reference_sftp_tests, image_bridge_tests) | PASS |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked -- -D warnings` | PASS |
| `pnpm test:ai:stage3` | 82 frontend; 21 + 249 native, 14 ignored in Runtime filter |
| `pnpm test:ai:stage4` | 54 frontend; 3 + 23 + 17 native; 9 provider-fixture ignored |
| `pnpm test:ai:stage3b` | 57 frontend; 109 + 6 + 1 + 17 native; 3 Runtime fixture ignored |
| `pnpm test:ai:stage5` | 18 scheduler; remaining filters 1 + 2 + 2 + 1 + 12 native, 1 ignored |
| `pnpm test:ai:stage6a` | 42 frontend + 17 native + 8 browser scenes PASS |
| `pnpm test:ai:stage6b` | 46 frontend + 32 native + explicit controller 1/1 + SSH 1 + 8 browser scenes PASS |
| `pnpm test:ai:stage6c` | 58 frontend + 14 native + explicit image bridge/8 browser scenes PASS |
| `git diff --check` | PASS |

The final browser rerun includes the authoritative target label/root display.
The final native lib/fmt/Clippy run includes the explicit Unavailable classification
for missing remote helper dependencies, preserving Skills retirement semantics.

One browser rerun timed out waiting for `plain.txt` after rapidly changing the
query through empty and absent results. The cause was not established. Failure
DOM/screenshot capture was added, and two consecutive standalone reruns then
passed all 8 scenes; this remains an observed intermittent test timeout, not a
confirmed product fix. Their evidence directories are
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-files-e2e-oA4mZT`
and `/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-files-e2e-L5MFMP`.

Evidence logs: `/tmp/shellspan-stage6d-gate.log`,
`/tmp/shellspan-stage6d-final-{frontend,tsc,build,scripts,browser,rust,fmt,clippy}.log`;
the second browser repeat is `/tmp/shellspan-stage6d-repeat-browser.log`;
regressions `/tmp/shellspan-stage6d-regression{3,4,3b,5,6a,6b,6c}.log`.
Reception `/tmp/shellspan-stage6d-reception6{a,b,c}.log`.
Each browser log prints its temporary screenshot/report directory. Screenshots
were inspected at narrow/light, narrow/dark and recovered/wide layouts. No existing
pixel baseline was changed; temporary screenshots/logs are not product files.

## Remaining boundaries and transfer

- Directory discovery is live, single-level prefix search. It does not implement
  recursive fuzzy ranking, ignore-file semantics, content attachments or glob search.
- Local cancellation checks run between OS operations; a stalled kernel filesystem
  call cannot be forcibly interrupted. Remote owned sockets/workers are cancellable.
- Windows code reuses the existing handle/reparse protection but was not compiled
  or run on Windows. Linux invalid-byte names do not prove Windows junction behavior.
- External live calls are reserved for Stage 7 using only this project's main
  `.env.local`. No keys were read, printed, copied or used here.
- Final Stage 7 all-target/all-feature gates, benchmarks, broader pixel comparisons
  and main integration are still required; stage-specific success does not replace them.

`node scripts/ai-runtime-stage6d-handoff.mjs` freezes cumulative products, verifies
all untracked files are classified, preserves historical 6A/B/C metadata, and
reconstructs both exact tracked-patch bases with every new product. The resulting
`inventory.json` and `reconstruction.json` contain source/patch hashes and verified
counts. Apply one tracked patch to its own base, copy **all** untracked products,
then verify all hashes. Generated handoff metadata excludes itself from products.
No commit, push, index change or main/source/Harness edit was performed.
