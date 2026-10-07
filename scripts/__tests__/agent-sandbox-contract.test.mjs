import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../protocol/agent/runtime/event-v5.schema.json'), 'utf8'));
const validator = new Ajv2020({ allErrors: true, strict: true });
const validate = validator.compile(schema);
const envelope = { version: 5, sessionId: 'session', seq: 0, timeUnixMs: 1 };
const contract = {
  version: 1, policy: 'workspace', target: { kind: 'local', targetId: 'local', sessionId: 'terminal' },
  bindingRevision: 0, sessionCreatedAtUnixMs: 1,
  executionSurface: 'direct', root: '/project', readAllow: ['/project'], writeAllow: ['/project'], deny: [],
  network: 'deny', source: 'session-intent', issuedAtUnixMs: 1, resourceGrants: [],
};

describe('sandbox v1 event vocabulary', () => {
  it('accepts frozen intent and rejects unsupported policies or persisted grants', () => {
    const event = { ...envelope, type: 'sandbox/call_frozen', turnId: 'turn', stepId: 'step', data: { callId: 'call', contract } };
    expect(validate(event), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...event, data: { ...event.data, contract: { ...contract, policy: 'operator' } } })).toBe(false);
    expect(validate({ ...event, data: { ...event.data, contract: { ...contract, resourceGrants: [{}] } } })).toBe(false);
    const { stepId: _stepId, ...unscoped } = event;
    expect(validate(unscoped)).toBe(false);
  });

  it('accepts legacy creation absence and the independent resource intents', () => {
    const event = { ...envelope, type: 'session/created', data: { taskId: 'task', goal: 'Inspect project', permissionMode: 'operator', executionSurface: 'direct' } };
    expect(validate(event)).toBe(true);
    for (const sandboxPolicy of ['readOnly', 'workspace', 'host']) {
      expect(validate({ ...event, data: { ...event.data, sandboxPolicy } })).toBe(true);
    }
    expect(validate({ ...event, data: { ...event.data, sandboxPolicy: 'full' } })).toBe(false);
  });

  it('validates rejection audit without implying process dispatch', () => {
    expect(validate({ ...envelope, type: 'sandbox/start_rejected', data: { reason: 'sandboxBackendUnavailable: restricted tools cannot dispatch' } })).toBe(true);
    expect(validate({ ...envelope, type: 'sandbox/start_rejected', data: {} })).toBe(false);
  });
});
