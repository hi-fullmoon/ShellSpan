# LLM catalog

`catalog.json` is ShellSpan's built-in exact-model catalog. It separates provider transport facts from model capability facts: each preset owns the adapter protocol and default compatibility behavior, while each model declares only its own capacities and capabilities plus any compatibility fields that differ from the preset.

## Provider connection checks

`ai_test_connection` accepts an unsaved provider configuration and a Tauri result
channel. It returns an ephemeral request ID; `ai_cancel_connection_test` cancels
that ID. Checks use the selected protocol adapter, model, reasoning option and
temporary API key, falling back to the saved route credential when no temporary
key is supplied. They send one short text request without tools or session
history, cap output at 128 tokens and stop after 30 seconds without retries.
No configuration or conversation is persisted. Results contain only elapsed
milliseconds on success, or a normalized error kind and HTTP status on failure;
provider bodies, generated text and credentials never enter the result channel.
Closing the editor, changing configuration or saving cancels its pending check.

## Add a built-in model

Add the exact wire model ID as a key under `presets.<provider>.models`. Every entry requires:

- `displayName` is optional presentation text; selectors fall back to the exact wire model ID when it is absent.
- `contextWindow`: combined input and output capacity.
- `maxOutputTokens`: declared model output capacity. It remains independent of a user-configured `contextWindow` and is never clamped when that window is reduced. Built-in catalog entries still describe capacities within the model's published context window.
- Custom definitions may also set `requestOutputTokens`: the actual per-request output limit, a positive integer no larger than `maxOutputTokens`. Admission reserves this value and every adapter sends it. Omission, including in older definitions, uses `min(maxOutputTokens, 16384, max(1, floor(contextWindow / 8)))`. Explicit request limits remain unchanged. The provider editor displays the effective allowance separately without changing the user's context or model output capacity.
- `toolCalling`, `textInput`, and `imageInput`: explicit `supported`, `unsupported`, or `unknown` states. Unknown tool support allows tools to be sent to the provider; only explicit `unsupported` blocks tool calling locally. Text and image input still require explicit support.
- `reasoning`: selectable reasoning levels in display order. Each item has a stable `id`, a `displayName`, and an optional provider-specific string `wireValue`. A missing `wireValue` sends the `id`; explicit `null` offers the selector value without sending a reasoning parameter. Use an empty list for a non-reasoning model.

`compat` is optional. It is a partial override of the preset's `compat`; include only fields whose wire behavior differs for this model. A model cannot override `protocol`, because the route's adapter owns it.

When `imageInput` is `supported`, `vision` is required and declares `maxRequestImages`, `maxRequestImageBytes`, `reservedTokensPerImage`, and the explanatory `imageTokenBudgetPolicy`. `vision` is rejected for models that do not support image input.

Example:

```json
"new-model-id": {
  "contextWindow": 131072,
  "maxOutputTokens": 8192,
  "toolCalling": "supported",
  "textInput": "supported",
  "imageInput": "unsupported",
  "reasoning": [
    { "id": "off", "displayName": "Off" },
    { "id": "high", "displayName": "High" }
  ],
  "compat": {
    "reasoningEncoding": "thinkingEffort"
  }
}
```

Run `pnpm check:llm:catalog` and `cargo test --manifest-path src-tauri/Cargo.toml llm::catalog_tests --lib`. The Rust fixture test verifies that compact catalog entries still resolve to the complete `ResolvedModel` contract consumed by the UI and runtime.

Custom route `models` and `modelOverrides` remain full `ModelDefinition` values. Unlike trusted built-in entries, they must explicitly carry `compat`; this keeps persisted user declarations self-contained and prevents an absent field from enabling a capability. The provider editor materializes every model before saving: an exact built-in ID inherits its catalog definition, while an uncatalogued ID starts with a 262,144-token context window, 32,768-token output cap, text support, unknown tool support, and no image or reasoning support. Discovered capacities and user edits override those fallbacks in the persisted definition.

The `openrouter` profile intentionally has no static models. Its catalog changes independently of ShellSpan releases, so the provider editor reads `GET /api/v1/models`, excludes entries carrying an `expiration_date`, retains each exact model slug, and adopts OpenRouter's capacities, tool parameters, reasoning-effort support, and input modalities into a complete persisted definition.

## Model discovery

Model discovery requests the configured endpoint (including curated providers)
and merges its exact IDs with the built-in catalog. Built-in definitions win for
duplicate IDs so an ID-only response cannot erase reviewed capabilities. New
IDs retain reported capacities without inheriting another model's capabilities.
An empty listing preserves built-ins. Network, HTTP, parsing and 15-second
timeout failures fall back to built-ins when available; routes without a built-in
catalog return the error. Discovery only produces candidates: manual addition,
explicit adoption and saving remain unchanged.

## Chat Completions reasoning replay

Returned `reasoning_details` are preserved even when the route does not request
MiniMax's `reasoning_split` extension. MiniMax cumulative streams update existing
details by index, ID, or positional identity; incremental streams preserve all
fragments in order, including repeated text. Empty or null optional fields are
valid and terminal placeholders do not erase earlier cumulative content.

Replay envelope v1 stores new Chat Completions reasoning details in response
metadata as `reasoningDetails`, independently of display text. This preserves
signed or encrypted blocks with no visible reasoning through tool calls and
session reloads. Readers still accept the previous block-level representation.
Same-domain history emits the preserved details once; cross-domain history
discards provider-private state. Older runtimes that do not recognize the new
response field cannot resume these new records; no stored history is rewritten.

Text, summary, signature, and encrypted data use the existing 8 MiB serialized
metadata budget, not the 64 KiB identifier limit. Optional strings may be absent,
null, or empty. Known text/summary prose may contain literal SSE `data:` syntax or
data URLs; opaque fields still reject embedded attachments, and credential-like
or unknown fields remain rejected. Invalid types report their indexed field;
size failures use `REPLAY_METADATA_TOO_LARGE` with byte counts and limits, never
the payload. Protocol failures remain non-retryable and never replay tools.

References: [MiniMax streaming and tool-use contract](https://platform.minimax.io/docs/api-reference/text-openai-api)
and [OpenRouter reasoning details](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

### MiniMax M3.1 Flash catalog

The exact API ID is `MiniMax-M3.1-Flash` (case-sensitive). It supports a
1,000,000-token context, text/image input and tool calls. The catalog keeps the
131,072-token model output capacity declaration; the provider hard ceiling is
524,288 tokens, including reasoning. Video input is supported by the provider
but is not advertised by ShellSpan's image-only attachment contract.

Thinking cannot be disabled. The OpenAI-compatible route uses `reasoning_effort`
with `low`, `medium`, `high`, `xhigh`, or `max`; omission uses the provider's `max`
default. Reasoning is returned separately and text stream chunks are incremental.
Image admission retains an application estimate of 4096 tokens per image, a
20-image application limit and a 10 MiB total image budget; token usage varies.

Verified on 2026-10-21 against the official
[model guide](https://platform.minimax.cn/docs/guides/text-generation),
[OpenAI SDK guide](https://platform.minimax.cn/docs/api-reference/text-openai-api)
and [Chat Completions reference](https://platform.minimax.cn/docs/api-reference/text-chat-openai).
