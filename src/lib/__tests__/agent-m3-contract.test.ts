import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import fixtures from '../../../protocol/agent/v3/m3-context-extension-fixtures.json';
import schema from '../../../protocol/agent/v3/m3-context-extension.schema.json';

describe('Agent v3 M3 context and extension protocol', () => {
  it('validates strict context, Skill, Hook, Runbook, and stdio MCP fixtures', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(fixtures), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects unknown fields, unsafe Hook authority, and unsupported MCP transports', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    const unknown = structuredClone(fixtures) as typeof fixtures & { capability?: string };
    unknown.capability = 'Skill text cannot grant this';
    expect(validate(unknown)).toBe(false);

    const unsafeHook = structuredClone(fixtures);
    unsafeHook.hooks.hooks[1] = {
      ...unsafeHook.hooks.hooks[1],
      mode: 'sync',
      event: 'afterTool',
      action: 'allow',
    } as never;
    expect(validate(unsafeHook)).toBe(false);

    const http = structuredClone(fixtures);
    http.mcp.servers[0].transport = 'streamableHttp' as 'stdio';
    expect(validate(http)).toBe(false);
  });

  it('keeps credential references opaque and excludes credential values from fixtures', () => {
    const encoded = JSON.stringify(fixtures);
    expect(encoded).toContain('credentialId');
    expect(encoded).not.toContain('accessToken');
    expect(encoded).not.toContain('clientSecret');
    expect(encoded).not.toContain('Bearer ');
  });
});
