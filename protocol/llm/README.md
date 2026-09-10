# LLM catalog

`catalog.json` is ShellSpan's built-in exact-model catalog. It separates provider transport facts from model capability facts: each preset owns the adapter protocol and default compatibility behavior, while each model declares only its own capacities and capabilities plus any compatibility fields that differ from the preset.

## Add a built-in model

Add the exact wire model ID as a key under `presets.<provider>.models`. Every entry requires:

- `displayName` is optional presentation text; selectors fall back to the exact wire model ID when it is absent.
- `contextWindow`: combined input and output capacity.
- `maxOutputTokens`: maximum output capacity; it must not exceed `contextWindow`.
- `toolCalling`, `textInput`, and `imageInput`: explicit `supported`, `unsupported`, or `unknown` states. Missing facts never grant a capability.
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
