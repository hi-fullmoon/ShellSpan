import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCatalog = new Ajv({ allErrors: true, strict: false })
  .compile(read('protocol/llm/catalog.schema.json'));
const validateRoutes = ajv.compile(read('protocol/llm/routes.schema.json'));

const catalog = read('protocol/llm/catalog.json');
assert(validateCatalog(catalog), ajv.errorsText(validateCatalog.errors));
const anthropic = catalog.presets.anthropic;
assert(anthropic?.kind === 'anthropicMessages', 'Anthropic preset protocol is missing');
assert(anthropic.compat.protocol === 'anthropicMessages', 'Anthropic compat protocol is incorrect');
assert(anthropic.compat.reasoningEncoding === 'anthropicAdaptive', 'Anthropic adaptive reasoning is missing');
assert(JSON.stringify(Object.keys(anthropic.models).sort()) === JSON.stringify([
  'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5',
]), 'Anthropic built-in model IDs changed unexpectedly');
for (const [modelId, model] of Object.entries(anthropic.models)) {
  assert(model.contextWindow === 1_000_000, `${modelId}: context window`);
  assert(model.maxOutputTokens === 128_000, `${modelId}: output limit`);
  assert(model.textInput === 'supported' && model.imageInput === 'supported' && model.toolCalling === 'supported', `${modelId}: capabilities`);
  assert(JSON.stringify(model.reasoning.map(level => level.id)) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']), `${modelId}: effort levels`);
}

const definition = anthropic.models['claude-sonnet-5'];
const selection = { routeId: 'anthropic-route', modelId: 'claude-sonnet-5', reasoningEffort: 'high' };
const route = {
  id: 'anthropic-route', revision: 1, displayName: 'Anthropic', adapterId: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com', auth: { kind: 'keychain', reference: 'ai.provider.anthropic-route.v1' },
  replayDomainId: 'domain-anthropic', presetId: 'anthropic', models: { 'claude-sonnet-5': definition }, defaults: selection,
  retryPolicy: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30000, jitterRatio: 0.2 },
  timeouts: { requestHeadersMs: 30000, firstByteMs: 30000, streamIdleMs: 300000 },
};
const document = { schemaVersion: 1, revision: 1, routes: [route], defaultSelection: selection, migrationComplete: true, migrationIssues: [] };
assert(validateRoutes(document), ajv.errorsText(validateRoutes.errors));
const anonymous = structuredClone(document);
anonymous.routes[0].auth = { kind: 'none' };
assert(!validateRoutes(anonymous), 'Anthropic route accepted anonymous auth');
assert(!JSON.stringify(document).match(/apiKey|authorization|bearer |data:image/i), 'Stage E fixture contains a credential or image payload');

console.log('Stage E Anthropic catalog and route schemas validated (1 positive, 1 negative fixture).');
