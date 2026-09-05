import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const schema = read('protocol/agent/runtime/event-v5.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const base = read('src/test/fixtures/agent-session-v5.json').find(event => event.type === 'assistant/message');
const prepared = structuredClone(base);
prepared.data.replay = {
  status: 'prepared',
  version: 1,
  adapterId: 'responses',
  replayFormatVersion: 1,
  source: {
    requestId: 'request-1',
    requestSnapshotDigest: '1'.repeat(64),
    routeId: 'route-a',
    routeRevision: 4,
    modelId: 'model-a',
    replayDomainId: 'domain-a',
    requestContentHash: '2'.repeat(64),
    preparationVersion: 1,
    projectionPolicy: 'immutable-png-v1-strict',
    imageProjectionRefs: [{
      version: 1,
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: 128,
      width: 16,
      height: 8,
      name: 'diagram.png',
    }],
    imageProjectionHash: '3'.repeat(64),
    assistantContentHash: '4'.repeat(64),
  },
  response: { responseId: 'resp_1' },
  blocks: prepared.data.content.map((block, index) => ({
    index,
    kind: block.type,
    contentHash: '5'.repeat(64),
    metadata: {},
  })),
};
assert(validate(prepared), ajv.errorsText(validate.errors));

for (const [label, mutate] of [
  ['unknown envelope version', value => { value.data.replay.version = 2; }],
  ['missing source binding', value => { delete value.data.replay.source.requestSnapshotDigest; }],
  ['invalid digest', value => { value.data.replay.source.assistantContentHash = 'not-a-digest'; }],
  ['unindexed block', value => { delete value.data.replay.blocks[0].index; }],
  ['unknown block kind', value => { value.data.replay.blocks[0].kind = 'native'; }],
  ['non-object response', value => { value.data.replay.response = 'raw'; }],
  ['embedded image bytes', value => { value.data.replay.source.imageProjectionRefs[0].data = 'data:image/png;base64,AAAA'; }],
]) {
  const candidate = structuredClone(prepared);
  mutate(candidate);
  assert(!validate(candidate), `${label}: unexpectedly accepted`);
}

assert(!JSON.stringify(prepared.data.replay).match(/apiKey|authorization|bearer |data:image/i));
console.log('Stage D replay envelope schema validated (1 positive, 7 negative fixtures).');
