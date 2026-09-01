import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import fixtures from '../../../protocol/agent/v3/agent-contract-fixtures.json';
import agentSchema from '../../../protocol/agent/v3/agent-contract.schema.json';
import toolManifest from '../../../protocol/agent/v3/built-in-tools.json';
import toolSchema from '../../../protocol/agent/v3/tool-contract.schema.json';
import manifestSchema from '../../../protocol/agent/v3/tool-manifest.schema.json';
import {
  AGENT_V3_EFFECT_KINDS,
  AGENT_V3_RESULT_STATUSES,
  AGENT_V3_TARGET_KINDS,
  AGENT_V3_TOOL_NAMES,
} from '@/types/agent-v3';

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(toolSchema);
  return {
    validateAgent: ajv.compile(agentSchema),
    validateManifest: ajv.compile(manifestSchema),
    validateCall: ajv.compile({
      $ref: `${toolSchema.$id}#/$defs/agentToolCall`,
    }),
    validateResult: ajv.compile({
      $ref: `${toolSchema.$id}#/$defs/agentToolResult`,
    }),
  };
}

describe('Agent Contract v3 draft', () => {
  it('validates the strict cross-language fixture and 12-tool manifest', () => {
    const { validateAgent, validateManifest } = validators();
    expect(validateAgent(fixtures), JSON.stringify(validateAgent.errors)).toBe(true);
    expect(validateManifest(toolManifest), JSON.stringify(validateManifest.errors)).toBe(true);
    expect(fixtures.examples.toolCalls.map((call) => call.toolName)).toEqual(AGENT_V3_TOOL_NAMES);
    expect(toolManifest.tools.map((tool) => tool.name)).toEqual(AGENT_V3_TOOL_NAMES);
    expect(toolSchema.$defs.toolName.enum).toEqual(AGENT_V3_TOOL_NAMES);
    expect(toolSchema.$defs.targetKind.enum).toEqual(AGENT_V3_TARGET_KINDS);
    expect(toolSchema.$defs.effectKind.enum).toEqual(AGENT_V3_EFFECT_KINDS);
    expect(toolSchema.$defs.toolResultBase.properties.status.enum).toEqual(
      AGENT_V3_RESULT_STATUSES,
    );
  });

  it('expresses one strict call and result shape for every built-in tool', () => {
    const { validateCall, validateResult } = validators();
    for (const call of fixtures.examples.toolCalls) {
      expect(validateCall(call), `${call.toolName}: ${JSON.stringify(validateCall.errors)}`).toBe(
        true,
      );
    }
    for (const result of fixtures.examples.toolResults) {
      expect(
        validateResult(result),
        `${result.toolName}: ${JSON.stringify(validateResult.errors)}`,
      ).toBe(true);
    }
  });

  it('rejects unknown envelope, argument, target, and result-data fields', () => {
    const { validateAgent } = validators();
    const cases = [
      (value: typeof fixtures & { unexpected?: boolean }) => {
        value.unexpected = true;
      },
      (value: typeof fixtures) => {
        Object.assign(value.examples.toolCalls[0].arguments, { unexpected: true });
      },
      (value: typeof fixtures) => {
        Object.assign(value.examples.toolCalls[0].target, { unexpected: true });
      },
      (value: typeof fixtures) => {
        Object.assign(value.examples.toolResults[0].data, { unexpected: true });
      },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(fixtures);
      mutate(invalid);
      expect(validateAgent(invalid)).toBe(false);
    }
  });

  it('fails closed for an unregistered tool, invalid target kind, or missing capability reference', () => {
    const { validateAgent } = validators();

    const unknownTool = structuredClone(fixtures);
    unknownTool.examples.toolCalls[0].toolName = 'future_tool' as 'exec_command';
    expect(validateAgent(unknownTool)).toBe(false);

    const invalidTarget = structuredClone(fixtures);
    invalidTarget.examples.toolCalls[4].target = invalidTarget.examples.toolCalls[1].target as never;
    expect(validateAgent(invalidTarget)).toBe(false);

    const noCapability = structuredClone(fixtures) as unknown as {
      examples: { toolCalls: Array<Record<string, unknown>> };
    };
    delete noCapability.examples.toolCalls[0].capabilityId;
    expect(validateAgent(noCapability)).toBe(false);
  });

  it('keeps request, call, result, tool, and target references correlated in canonical fixtures', () => {
    const request = fixtures.examples.request;
    const targetIds = new Set(request.targets.map((target) => target.targetId));
    for (const [index, call] of fixtures.examples.toolCalls.entries()) {
      const result = fixtures.examples.toolResults[index];
      expect(call.requestId).toBe(request.requestId);
      expect(result.requestId).toBe(request.requestId);
      expect(result.callId).toBe(call.callId);
      expect(result.toolName).toBe(call.toolName);
      expect(result.targetId).toBe(call.target.targetId);
      expect(targetIds.has(call.target.targetId)).toBe(true);
    }
  });
});
