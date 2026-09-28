import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const schema = JSON.parse(await readFile(path.join(root, 'protocol/agent/runtime/tool-contract.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const base = {
  requestId: 'diagnostic-request', callId: 'diagnostic-call', capabilityId: 'diagnostic-capability',
  target: { kind: 'local', targetId: 'local-host', sessionId: 'terminal' },
};

describe('diagnostic native contract', () => {
  it.each([
    ['inspect_host', { fields: ['system', 'cpu'] }],
    ['inspect_service', { service: 'ssh.service' }],
    ['query_logs', { service: 'ssh.service', sinceUnixMs: 1, untilUnixMs: 1000, maxEntries: 1 }],
    ['diagnose_endpoint', { host: 'localhost', port: 443, protocol: 'https' }],
  ])('admits %s without requiring a project directory', (toolName, args) => {
    expect(validate({ ...base, toolName, arguments: args }), ajv.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...base, toolName, arguments: { ...args, command: 'id' } })).toBe(false);
    expect(validate({ ...base, toolName, arguments: args,
      target: { kind: 'process', targetId: 'process', ownerTargetId: 'local-host', processHandle: 'process-handle' },
    })).toBe(false);
  });

  it('requires bounded journal scope and rejects credential/header overrides', () => {
    expect(validate({ ...base, toolName: 'query_logs', arguments: { service: 'ssh.service' } })).toBe(false);
    expect(validate({ ...base, toolName: 'query_logs', arguments: {
      service: 'ssh.service', sinceUnixMs: 1, untilUnixMs: 1000, maxEntries: 201,
    } })).toBe(false);
    expect(validate({ ...base, toolName: 'diagnose_endpoint', arguments: {
      host: 'localhost', port: 443, protocol: 'https', verify: false,
    } })).toBe(false);
  });

  it('accepts collection failure without turning it into a healthy result', () => {
    expect(validate({ requestId: base.requestId, callId: base.callId, toolName: 'inspect_service',
      targetId: 'local-host', status: 'failed', summary: 'inspect_service: unavailable',
      data: { schemaVersion: 1, status: 'unavailable', code: 'unsupported', targetId: 'local-host' },
    }), ajv.errorsText(validate.errors)).toBe(true);
  });
});
