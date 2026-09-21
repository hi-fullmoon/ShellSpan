# Session titles

After a successful text or image submission command, a top-level session checks
whether that submission is its first committed human inbox message. Only that
message can schedule a best-effort title request using the selected model and
the existing LLM runtime. Creating a session or selecting/starting a model never
triggers title generation. The input is the committed message content, not the
draft or placeholder goal captured during file/skill browsing. The agent's atomic
title claim deduplicates concurrent retries; later submissions cannot trigger it.
It runs concurrently with the conversation, has no tools, consumes at most 4,000
Unicode characters of the redacted message, and times out after 20 seconds of model
streaming. Cancellation propagates from the owning agent; title cancellation does
not cancel the conversation. Failure leaves the display fallback intact. A
persisted model selection does not prevent the first message from generating a
title. Existing conversations do not generate a new title on later messages.

The model returns a JSON object containing `title`. The prompt asks for 8–16
Chinese characters or 3–6 English words. The result must be nonempty and single
line; it is redacted and limited to 48 Unicode code points including any ellipsis.

The title commits through the existing v5 `session/renamed` event, with an
`auto-title-` operation ID and the current revision. Under the session store lock,
the commit is skipped if a title already exists, or the session is archived or
terminal. Thus a manual rename that wins the race is never overwritten, and a
later manual rename can replace the generated title. No schema change is needed.

Both conversation and list projections use the same display-only fallback:
collapse whitespace in the goal and limit it to 48 Unicode code points including
an ellipsis. This also bounds old untitled sessions without modifying their goals.
Explicit titles retain the existing manual rename limits and are not truncated
in storage. The UI continues to apply its existing width-based ellipsis.
