import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import legacyFixtures from '../../../protocol/agent/v1/agent-contract-fixtures.json';
import legacySchema from '../../../protocol/agent/v1/agent-contract.schema.json';
import fixtures from '../../../protocol/agent/v2/agent-contract-fixtures.json';
import schema from '../../../protocol/agent/v2/agent-contract.schema.json';
import {
  classifyAgentRisk,
  evaluateAgentPermission,
  freezeAgentTarget,
  resolveAgentContractStatus,
  resolveAgentProviderCapability,
} from '../agent-contract';
import {
  AGENT_CAPABILITY_SOURCES,
  AGENT_TASK_OUTCOMES,
  AGENT_PERMISSION_MODES,
  AGENT_RISKS,
  AGENT_STREAM_EVENT_TYPES,
  AGENT_TOOL_CALLING_SUPPORT,
  AGENT_TOOL_RESULT_STATUSES,
  type AgentApprovalDecision,
  type AgentPermissionMode,
} from '@/types/agent';

interface PermissionMatrixCase {
  name: string;
  mode: AgentPermissionMode;
  risk: string;
  expected: AgentApprovalDecision;
}

describe('Agent v2 shared contract', () => {
  it('validates the checked-in cross-language fixtures against the strict schema', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(fixtures), JSON.stringify(validate.errors)).toBe(true);

    const invalid = structuredClone(fixtures) as typeof fixtures & { unexpected?: boolean };
    invalid.unexpected = true;
    expect(validate(invalid)).toBe(false);
  });

  it('preserves the v1 contract artifacts for historical compatibility', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(legacySchema);
    expect(validate(legacyFixtures), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps wire enum values synchronized with the canonical schema', () => {
    const definitions = schema.$defs;
    expect(definitions.agentPermissionMode.enum).toEqual(AGENT_PERMISSION_MODES);
    expect(definitions.agentRisk.enum).toEqual(AGENT_RISKS);
    expect(definitions.agentToolResult.properties.status.enum).toEqual(AGENT_TOOL_RESULT_STATUSES);
    expect(definitions.providerCapability.properties.support.enum).toEqual(AGENT_TOOL_CALLING_SUPPORT);
    expect(definitions.providerCapability.properties.source.enum).toEqual(AGENT_CAPABILITY_SOURCES);
    expect(definitions.agentTaskOutcome.enum).toEqual(AGENT_TASK_OUTCOMES);
    expect(definitions.agentStreamEventType.enum).toEqual(AGENT_STREAM_EVENT_TYPES);
    expect(fixtures.examples.streamEvents.map((event) => event.type)).toEqual(
      AGENT_STREAM_EVENT_TYPES,
    );
  });
});

describe('Agent permission matrix', () => {
  it.each(fixtures.permissionMatrix as PermissionMatrixCase[])('$name', ({ mode, risk, expected }) => {
    expect(evaluateAgentPermission(mode, classifyAgentRisk(risk))).toEqual(expected);
  });

  it.each([undefined, null, '', 'futureRisk', 42, { risk: 'readOnly' }])(
    'fails closed for an unknown risk value: %j',
    (risk) => {
      expect(evaluateAgentPermission('fullAccess', classifyAgentRisk(risk))).toEqual({
        requiresApproval: true,
        reason: 'unclassifiedRisk',
      });
    },
  );

  it('fails closed for an unknown permission mode', () => {
    expect(evaluateAgentPermission('futureMode', classifyAgentRisk('readOnly'))).toEqual({
      requiresApproval: true,
      reason: 'modeRequiresApproval',
    });
  });
});

describe('Agent target and provider capability contracts', () => {
  it('freezes an owned target snapshot instead of retaining the active target object', () => {
    const activeTarget = {
      kind: 'remote' as const,
      sessionId: 'session-a',
      profileId: 'profile-1',
      host: 'a.example.com',
      port: 22,
      username: 'operator',
    };
    const snapshot = freezeAgentTarget(activeTarget);
    activeTarget.sessionId = 'session-b';
    activeTarget.host = 'b.example.com';

    expect(snapshot).toEqual({
      kind: 'remote',
      sessionId: 'session-a',
      profileId: 'profile-1',
      host: 'a.example.com',
      port: 22,
      username: 'operator',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('requires positive capability evidence for compatible and Ollama providers', () => {
    expect(resolveAgentProviderCapability('openAiCompatible')).toEqual({
      support: 'unknown',
      source: 'chatCompletionsProbe',
    });
    expect(resolveAgentProviderCapability('ollama')).toEqual({
      support: 'unknown',
      source: 'ollamaModelMetadata',
    });
    expect(resolveAgentProviderCapability('ollama', {
      support: 'supported',
      source: 'chatCompletionsProbe',
    })).toEqual({
      support: 'unknown',
      source: 'ollamaModelMetadata',
    });
  });

  it('defaults the disabled experiment and unsupported providers to read-only Ask', () => {
    expect(resolveAgentContractStatus(false, 'openAi')).toMatchObject({
      featureEnabled: false,
      agentAvailable: false,
      defaultPermissionMode: 'requestApproval',
      fallback: {
        task: 'ask',
        automaticExecution: false,
        assistantTextExecution: 'forbidden',
        reason: 'featureDisabled',
      },
    });
    expect(resolveAgentContractStatus(true, 'ollama', {
      support: 'unsupported',
      source: 'ollamaModelMetadata',
    })).toMatchObject({
      agentAvailable: false,
      fallback: { reason: 'toolCallingUnsupported' },
    });
    const available = resolveAgentContractStatus(true, 'openAi');
    expect(available).toMatchObject({ agentAvailable: true });
    expect(available).not.toHaveProperty('fallback');
  });
});
