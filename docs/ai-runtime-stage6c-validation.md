# Stage 6C validation — 2026-09-04

Scope: macOS arm64 implementation and isolated local HTTP/Linux fixtures.
Windows native compilation/execution and external provider live tests are **NOT
RUN**. Stage 6D, final Stage 7 and main integration remain pending.

## Behavior evidence

| Boundary | Evidence |
| --- | --- |
| Native input | Four actual decoded source formats, MIME/base64/name/ref bounds, metadata stripping, EXIF rotation, ICC rejection, GIF animation, pixel/side limits, 16-bit gray→RGBA8 |
| Immutable storage | Re-import/hash identity, no clobber, tampered and missing blob refusal, Session-authorized preview and cross-Session denial |
| Atomicity | Invalid second image, second blob publication failure, log append failure; zero partial Inbox messages and zero model calls |
| Cancellation | Five pre-commit boundaries; after-commit receipt wins, original operation retry cannot duplicate input |
| Concurrency | Simultaneous identical submissions commit once; conflicting original bytes/name/text rejected; imports bounded per shared store |
| Recovery | Every complete log prefix from enqueue through RequestHeader, each with/without partial trailing JSONL, repairs one user input and resolves real image bytes; receipt works before reattach |
| Compaction | Completed compaction retains one typed image ref; restart resolves it again, independently of the summary |
| Provider/budget | Exact profile/model/protocol whitelist; unknown/text-only model sends no request; fifth retained image rejected; token reserve is estimated context, not provider usage |
| Draft persistence | Controlled promise tests cover stale remove success/failure, text failure, cancel true/false/failure and import across A→B→A; durable intent precedes IPC, failed send retains fixed operation |
| Real IndexedDB | Browser CAS concurrent writes have exactly one winner; pending cold-owner draft is discoverable through its bound Session |
| Real user route | Production controller→adapter→IPC payload wrappers→Rust Runtime/local Skills→OpenAI-compatible HTTP receiver; no rootless Session at selection, exact project cwd and complete Skill instructions |
| Actual pixels | Receiver decodes image data URLs and compares bytes to immutable hash files; events contain refs only; restarted text follow-up sends identical pixels |
| Layout/feedback | 320/400/560/720 × light/en-US and dark/zh-CN; add/remove, reload, failed submit/retry, unsupported→supported switch, empty post-send draft, one MessageScroller, no page horizontal overflow |

`image_tests.rs` contains 14 deterministic native cases. `image_bridge_tests.rs`
is ignored by ordinary cargo test and explicitly executed by the browser gate.
Only the desktop IPC channel is substituted; no fake runtime/model serialization
or fixed response JSON replaces the production admission and request paths.
The local HTTP model intentionally emits deterministic SSE text, not a live model.

## Commands and results

Command-scoped Rust cache only:
`CARGO_TARGET_DIR=/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan/src-tauri/target`.
Node 24.15.0, pnpm 11.1.1, Rust 1.95.0. No global toolchain/config changes.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS before implementation; pnpm lock/workspace unchanged |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm test` | 1460 passed, 1 skipped; 171 passed files/1 skipped |
| `pnpm build` | PASS; existing large-chunk advisory only |
| `pnpm test:scripts` | 29 passed |
| Rust lib `--locked --no-fail-fast` | 591 passed, 24 ignored |
| `cargo fmt --all -- --check`, explicit image include-file rustfmt | PASS |
| `cargo clippy --lib --locked -- -D warnings` | PASS |
| `pnpm test:ai:stage6c` | 14 native + 56 frontend + explicit HTTP bridge + 8 browser scenes PASS |
| Stage 3 / 4 / 3B / 5 | PASS cumulative regression; scheduler, retry, provider, compaction and restart gates |
| Stage 6A | 40 frontend, 17 native, 8 question browser scenes PASS |
| Stage 6B | 44 frontend, 32 native, real controller bridge 1+1, isolated SFTP 1, 8 Skills browser scenes PASS |
| Request/start/system prompts | Included in full native/frontend and Stage 6C controller/projection/snapshot gate |

Final logs: `/tmp/shellspan-stage6c-verified-{gate,frontend,build,scripts,rust,clippy}.log`.
Regression logs: `/tmp/shellspan-stage6c-regression{3,4,3b,5,6a,6b}.log`.
Final image screenshots/report:
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-images-e2e-6jgJpD`.
Question and Skills evidence:
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-question-visual-dLGcEa`,
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-skills-visual-agOsKC`.
Temporary evidence is not a product file and no unrelated pixel baseline was updated.

## Issues discovered and resolved

- Global import permits caused two parallel cargo cases to fail; ownership moved
  to the shared ImageStore. Final full lib runs pass without serializing all tests.
- Stale draft callbacks now check generation as well as owner, including ABA.
- Image selection no longer creates a Session before explicit Skills directory binding.
- Recovery-only text submissions now reattach image-bearing Sessions and preserve vision input.
- Native file input's permanent English row was replaced by a localized Button;
  errors are actionable and a corrected model choice clears the stale refusal.
- Browser assertions were updated for localized feedback, and child processes now
  cleanly terminate without leaving a nested pnpm/Vite or Rust test process.
- Context limits are now an explicit conservative app policy, not an unverified
  maximum inferred from an older model listing.

## Frozen transfer

`node scripts/ai-runtime-stage6c-handoff.mjs` generates the inventory and two tracked
patches without touching index/refs. Both exact bases are reconstructed in temporary
directories, followed by every listed untracked product and a SHA-256 comparison of
all cumulative source files. Generated handoff metadata excludes itself and retains
historical 6A/6B metadata. See `reconstruction.json` in the handoff directory for
the checked counts and inventory hash. Re-freeze and re-verify after any source edit.

No secrets were copied/read from `.env.local`; same-project live configuration is
available in main and reserved for Stage 7. No external live, Windows native,
cross-device draft migration, full color management or automatic blob GC claim.
