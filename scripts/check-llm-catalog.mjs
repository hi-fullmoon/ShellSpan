import fs from 'node:fs';
import assert from 'node:assert/strict';
import Ajv from 'ajv';

const schema = JSON.parse(fs.readFileSync(new URL('../protocol/llm/catalog.schema.json', import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(new URL('../protocol/llm/catalog.json', import.meta.url)));
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
assert(validate(catalog), JSON.stringify(validate.errors));
for (const preset of Object.values(catalog.presets)) {
  for (const model of Object.values(preset.models)) {
    assert(model.maxOutputTokens <= model.contextWindow);
    assert(!model.vision || model.vision.reservedTokensPerImage <= model.contextWindow);
    assert.equal(new Set(model.reasoning.map(o => o.id)).size, model.reasoning.length);
  }
}
for (const mutate of [
  c => { c.presets.qwen.compat.unknownPatch = {}; },
  c => { c.presets.qwen.models.qwen3.compat.protocol = 'ollama'; },
  c => { c.presets.qwen.models.qwen3.maxOutputTokens = 0; },
  c => { c.presets.qwen.models.qwen3.reasoning[0].id = 'ultra'; },
]) {
  const invalid = structuredClone(catalog);
  mutate(invalid);
  assert(!validate(invalid), 'invalid catalog unexpectedly passed schema validation');
}
console.log(`LLM catalog schema: ${Object.values(catalog.presets).reduce((n, p) => n + Object.keys(p.models).length, 0)} exact models validated; 4 negative fixtures rejected.`);
