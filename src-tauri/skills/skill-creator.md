# Skill creator

Distill a verified, reusable workflow from the current conversation into a structured ShellSpan Skill and submit it for human review through `propose_skill`. Answer in the user's language. Loading this skill grants no permission to write files or execute commands.

## Decide create vs update

1. Inspect the active `<skill_catalog>` before drafting.
2. If an existing skill already covers this service or procedure and the user wants to refine or add lessons learned, call `skill({ name })` first to read its current instructions, then merge the updates cleanly using `mode: "update"` instead of creating `-v2` duplicates.
3. If the conversation spans multiple unrelated tasks and the scope is unclear, ask one concise question via `ask_user_question` to confirm which procedure to capture before calling `propose_skill`.

## Distill a high-signal skill

1. **Keep verified steps, drop noise**: Retain the working end-to-end procedure, prerequisites, verification checks, and rollback steps. Discard failed experiments, transient probe output, and one-off log dumps.
2. **Preserve guardrails and user corrections**: Capture every safety constraint, preflight check, approval boundary, or correction the user emphasized during the session.
3. **Parameterize environment specifics**: Replace one-off hostnames, IP addresses, release versions, temporary directories, or container IDs with clear input parameters or explicit pre-execution confirmation items.
4. **Scrub all secrets**: Never include passwords, API keys, tokens, private keys, certificates with private material, or credential-bearing URLs. Refer to existing environment variables, system keychain entries, or manual user steps instead.
5. **Write a crisp trigger description**: Set `description` (<= 500 chars) to state clearly *when* the skill applies and *what* it does. Keep `name` as lowercase kebab-case (`a-z`, `0-9`, `-`, <= 64 chars).
6. **Set invocation safety by risk**: Keep `userInvocable: true`. For high-risk procedures (production deployments, service restarts, database migrations, destructive cleanups), set `disableModelInvocation: true` by default so the skill runs only when the user explicitly invokes `/name`.

## Submit through `propose_skill`

- Default `scope` to `"user"` so the skill is stored locally in `~/.shellspan/skills/<name>/SKILL.md` and reusable across local and remote SSH sessions without modifying remote hosts.
- Only use `scope: "workspace"` when the user explicitly asks to save into the bound local project repository (`.agents/skills/`).
- Never use `write_file`, `edit_file`, `apply_patch`, or shell commands to write into `~/.shellspan/skills/` or `.agents/skills/`. Always call `propose_skill` and wait for the user's review.
- If the user requests revisions (`revision_requested`), apply their feedback directly and call `propose_skill` again.
