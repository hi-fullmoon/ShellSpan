import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEvent = ajv.compile(read('protocol/agent/runtime/event-v5.schema.json'));
const validateRoutes = ajv.compile(read('protocol/llm/routes.schema.json'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const accepts = (validate, value, label) => assert(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`);
const rejects = (validate, value, label) => assert(!validate(value), `${label}: unexpectedly accepted`);

for (const fixture of ['src/test/fixtures/agent-session-v5.json', 'src/test/fixtures/agent-skills-runtime.json']) {
  for (const [index, event] of read(fixture).entries()) accepts(validateEvent, event, `${fixture}[${index}]`);
}
const header = read('src/test/fixtures/agent-session-v5.json').find(event => event.type === 'request/header');
rejects(validateEvent, { ...header, version: 4 }, 'v4 reader rejection');
const { snapshot: _snapshot, snapshotDigest: _digest, ...missingSnapshotData } = header.data;
rejects(validateEvent, { ...header, data: missingSnapshotData }, 'missing request snapshot');
rejects(validateEvent, { ...header, unexpected: true }, 'unknown event envelope field');
assert(!JSON.stringify(header.data.snapshot).match(/apiKey|authorization|bearer |data:image/i), 'snapshot contains credential or base64 material');

const catalog = read('protocol/llm/catalog.json');
const [presetId, preset] = Object.entries(catalog.presets)[0];
const [modelId, definition] = Object.entries(preset.models)[0];
const selection = { routeId: 'route-a', modelId };
const route = {
  id: 'route-a', revision: 1, displayName: 'Route A',
  adapterId: preset.kind === 'openAi' ? 'responses'
    : preset.kind === 'ollama' ? 'ollama'
      : preset.kind === 'anthropicMessages' ? 'anthropic-messages'
        : 'chat-completions',
  baseUrl: 'https://example.com', auth: preset.kind === 'anthropicMessages'
    ? { kind: 'keychain', reference: 'ref' }
    : { kind: 'none' }, replayDomainId: 'domain-a',
  presetId, models: { [modelId]: definition }, defaults: selection,
  retryPolicy: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30000, jitterRatio: 0.2 },
  timeouts: { requestHeadersMs: 30000, firstByteMs: 30000, streamIdleMs: 300000 },
};
const document = { schemaVersion: 1, revision: 1, routes: [route], defaultSelection: selection, migrationComplete: true, migrationIssues: [] };
accepts(validateRoutes, document, 'route document');
rejects(validateRoutes, { ...document, routes: [{ ...route, modelOverrides: { [modelId]: definition } }] }, 'models and overrides exclusivity');
rejects(validateRoutes, { ...document, routes: [{ ...route, auth: { kind: 'keychain', reference: 'ref', extra: true } }] }, 'strict route auth');
rejects(validateRoutes, { ...document, routes: [{ ...route, models: { [modelId]: { ...definition, compat: { ...definition.compat, extra: true } } } }] }, 'strict compat');

console.log('Stage C schemas and fixtures validated.');
