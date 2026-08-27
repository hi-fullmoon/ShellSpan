import { describe, expect, it } from 'vitest';
import decisionFixture from '../../../tests/fixtures/agent-protocol/v1/agent-decisions.json';
import {
  AGENT_DECISION_SCHEMA_V1,
  decodeAgentDecisionV1,
  decodeAgentEventV1,
  decodeAgentRunSnapshotV1,
  decodeAgentStartRequestV1,
  MAX_AGENT_DECISION_BYTES_V1,
} from '@/lib/agent-protocol';
import { AGENT_BUDGET_DEFAULTS_V1 } from '@/lib/agent-budgets';

describe('Agent protocol v1 decision decoder', () => {
  it('parses the shared bilateral fixtures and round-trips every valid value', () => {
    for (const fixture of decisionFixture.cases) {
      const decode = () => decodeAgentDecisionV1(JSON.stringify(fixture.value));
      if (!fixture.valid) {
        expect(decode, fixture.name).toThrow();
        continue;
      }
      const decision = decode();
      expect(decision.kind, fixture.name).toBe(fixture.expectedKind);
      expect('tool' in decision ? decision.tool : undefined, fixture.name).toBe(fixture.expectedTool);
      expect(decision, fixture.name).toEqual(fixture.value);
    }
  });

  it('rejects surrounding prose, code fences, a second action, and oversized documents', () => {
    const valid = JSON.stringify({
      schemaVersion: 1,
      kind: 'askUser',
      rationale: 'Need scope.',
      plan: { items: [] },
      question: 'Which service?',
    });
    expect(() => decodeAgentDecisionV1(valid)).not.toThrow();
    expect(() => decodeAgentDecisionV1(`answer: ${valid}`)).toThrow(/single JSON document/);
    expect(() => decodeAgentDecisionV1(`\`\`\`json\n${valid}\n\`\`\``)).toThrow();
    expect(() => decodeAgentDecisionV1(`${valid}\n${valid}`)).toThrow();
    expect(() => decodeAgentDecisionV1(JSON.stringify({
      schemaVersion: 1,
      kind: 'askUser',
      rationale: 'x'.repeat(MAX_AGENT_DECISION_BYTES_V1),
      plan: { items: [] },
      question: 'q',
    }))).toThrow(/64 KiB/);
  });

  it('checks in a four-variant, version-locked, closed JSON schema', () => {
    expect(AGENT_DECISION_SCHEMA_V1.$id)
      .toBe('https://termbridge.app/protocol/agent/v1/agent-decision.schema.json');
    const variants = AGENT_DECISION_SCHEMA_V1.oneOf as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(4);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
      const properties = variant.properties as Record<string, { const?: unknown }>;
      expect(properties.schemaVersion.const).toBe(1);
    }
  });
});

describe('Agent protocol v1 IPC envelopes', () => {
  it('decodes only the narrow start request and rejects target or policy injection', () => {
    const valid = {
      schemaVersion: 1,
      clientRequestId: 'request-1',
      goal: 'Inspect CPU pressure without changes.',
      profileId: 'profile-1',
      providerId: 'openai',
      requestedBudgets: { maxToolCalls: 5 },
    };
    expect(decodeAgentStartRequestV1(valid)).toEqual(valid);
    expect(() => decodeAgentStartRequestV1({ ...valid, schemaVersion: 2 })).toThrow(/must be 1/);
    expect(() => decodeAgentStartRequestV1({ ...valid, host: 'other.example.test' })).toThrow(/unknown field host/);
    expect(() => decodeAgentStartRequestV1({
      ...valid,
      requestedBudgets: { maxToolCalls: 5, unlimited: true },
    })).toThrow(/unknown field unlimited/);
    expect(() => decodeAgentStartRequestV1({ ...valid, terminalContext: null })).toThrow();
  });

  it('fails closed on unknown event fields, versions, and event enums', () => {
    const event = {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      occurredAt: 1_000,
      type: 'run.created',
      payload: {},
    };
    expect(decodeAgentEventV1(event)).toEqual(event);
    expect(() => decodeAgentEventV1({ ...event, schemaVersion: 2 })).toThrow();
    expect(() => decodeAgentEventV1({ ...event, type: 'run.restarted' })).toThrow(/unknown enum/);
    expect(() => decodeAgentEventV1({ ...event, rawOutput: 'secret' })).toThrow(/unknown field/);
  });

  it('strictly decodes a snapshot and rejects late unknown state or payload expansion', () => {
    const snapshot = {
      schemaVersion: 1,
      runId: 'run-1',
      lastSequence: 2,
      state: 'thinking',
      target: {
        profileId: 'profile-1',
        profileLabel: 'Production',
        host: 'prod.example.test',
        port: 22,
        username: 'operator',
        authMethod: 'password',
        targetDigest: 'sha256-v1:fixture',
      },
      provider: {
        providerId: 'openai',
        kind: 'openAi',
        baseUrl: 'https://api.openai.com',
        model: 'fixture-model',
        capabilities: {
          streaming: true,
          strictJsonSchema: true,
          nativeToolCalling: false,
          usageReporting: true,
          responseContinuation: true,
        },
      },
      policy: {
        mode: 'readOnly',
        policyVersion: 'p1-v1',
        toolRegistryVersion: 'p1-v1',
        allowedTools: ['host.inspect', 'shell.execReadOnly'],
      },
      budgets: {
        schemaVersion: 1,
        policy: AGENT_BUDGET_DEFAULTS_V1,
        usage: {
          elapsedMillis: 100,
          modelTurnsUsed: 1,
          toolCallsUsed: 0,
          consecutiveInvalidDecisions: 0,
          consecutiveToolFailures: 0,
          steeringQueueItems: 0,
        },
      },
      goal: 'Inspect CPU pressure.',
      plan: [],
      toolCalls: [],
      evidence: [],
      queuedSteeringCount: 0,
    };
    expect(decodeAgentRunSnapshotV1(snapshot)).toEqual(snapshot);
    expect(() => decodeAgentRunSnapshotV1({ ...snapshot, state: 'running' })).toThrow(/unknown enum/);
    expect(() => decodeAgentRunSnapshotV1({ ...snapshot, rawOutput: 'secret' })).toThrow(/unknown field/);
    expect(() => decodeAgentRunSnapshotV1({
      ...snapshot,
      target: { ...snapshot.target, password: 'secret' },
    })).toThrow(/unknown field password/);
  });
});
