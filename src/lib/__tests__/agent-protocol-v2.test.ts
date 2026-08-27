import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import decisionFixture from '../../../tests/fixtures/agent-protocol/v2/agent-decisions.json';
import eventFixture from '../../../tests/fixtures/agent-protocol/v2/agent-events.json';
import snapshotFixture from '../../../tests/fixtures/agent-protocol/v2/agent-snapshots.json';
import backwardFixture from '../../../tests/fixtures/agent-protocol/v2/backward-compatibility.json';
import { decodeAgentDecisionV1 } from '@/lib/agent-protocol';
import {
  AGENT_DECISION_SCHEMA_V2,
  AGENT_EVENT_SCHEMA_V2,
  AGENT_SNAPSHOT_SCHEMA_V2,
  decodeAgentDecisionV2,
  decodeAgentEventV2,
  decodeAgentRunSnapshotV2,
  decodeAgentStartRequestV2,
} from '@/lib/agent-protocol-v2';

interface ProtocolCase {
  name: string;
  valid: boolean;
  value?: unknown;
  expectedKind?: string;
  expectedTool?: string;
  expectedType?: string;
  deriveFrom?: number;
  patch?: Record<string, unknown>;
}

function materialize(cases: readonly ProtocolCase[], fixtureCase: ProtocolCase): unknown {
  const base = fixtureCase.deriveFrom === undefined
    ? structuredClone(fixtureCase.value)
    : structuredClone(cases[fixtureCase.deriveFrom]?.value);
  if (!base || typeof base !== 'object') throw new Error(`Invalid fixture base: ${fixtureCase.name}`);
  for (const [path, replacement] of Object.entries(fixtureCase.patch ?? {})) {
    applyPatch(base, path, replacement);
  }
  return base;
}

function applyPatch(root: object, path: string, replacement: unknown): void {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(part)];
    else current = (current as Record<string, unknown>)[part];
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = replacement;
  else (current as Record<string, unknown>)[last] = replacement;
}

describe('Agent protocol v2', () => {
  it('parses and round-trips the shared decision fixtures', () => {
    expect(decisionFixture.schemaVersion).toBe(2);
    for (const fixtureCase of decisionFixture.cases as ProtocolCase[]) {
      const value = materialize(decisionFixture.cases as ProtocolCase[], fixtureCase);
      if (!fixtureCase.valid) {
        expect(() => decodeAgentDecisionV2(JSON.stringify(value)), fixtureCase.name).toThrow();
        continue;
      }
      const decoded = decodeAgentDecisionV2(JSON.stringify(value));
      expect(decoded, fixtureCase.name).toEqual(value);
      expect(decoded.kind).toBe(fixtureCase.expectedKind);
      expect(decoded.kind === 'toolCall' ? decoded.tool : undefined).toBe(fixtureCase.expectedTool);
    }
  });

  it('strictly correlates every event type with its payload', () => {
    expect(eventFixture.schemaVersion).toBe(2);
    for (const fixtureCase of eventFixture.cases as ProtocolCase[]) {
      const value = materialize(eventFixture.cases as ProtocolCase[], fixtureCase);
      if (!fixtureCase.valid) {
        expect(() => decodeAgentEventV2(value), fixtureCase.name).toThrow();
        continue;
      }
      const decoded = decodeAgentEventV2(value);
      expect(decoded, fixtureCase.name).toEqual(value);
      expect(decoded.type).toBe(fixtureCase.expectedType);
    }
  });

  it('strictly decodes the full v2 snapshot projection and rejects unknown tools', () => {
    expect(snapshotFixture.schemaVersion).toBe(2);
    for (const fixtureCase of snapshotFixture.cases as ProtocolCase[]) {
      const value = materialize(snapshotFixture.cases as ProtocolCase[], fixtureCase);
      if (!fixtureCase.valid) {
        expect(() => decodeAgentRunSnapshotV2(value), fixtureCase.name).toThrow();
        continue;
      }
      expect(decodeAgentRunSnapshotV2(value), fixtureCase.name).toEqual(value);
    }
  });

  it('preserves the explicit v1/v2 backward compatibility boundary', () => {
    expect(backwardFixture.schemaVersion).toBe(2);
    for (const fixtureCase of backwardFixture.cases) {
      const raw = JSON.stringify(fixtureCase.value);
      const v1 = () => decodeAgentDecisionV1(raw);
      const v2 = () => decodeAgentDecisionV2(raw);
      if (fixtureCase.acceptedByV1) expect(v1, fixtureCase.name).not.toThrow();
      else expect(v1, fixtureCase.name).toThrow();
      if (fixtureCase.acceptedByV2) expect(v2, fixtureCase.name).not.toThrow();
      else expect(v2, fixtureCase.name).toThrow();
    }
  });

  it('strictly decodes v2 start requests without admitting executor selection', () => {
    const valid = {
      schemaVersion: 2,
      clientRequestId: 'request-2',
      goal: 'Inspect and propose a controlled service action.',
      profileId: 'profile-1',
      providerId: 'openai',
      requestedPolicyMode: 'strict',
      requestedBudgets: { maxMutationProposals: 3 },
    };
    expect(decodeAgentStartRequestV2(valid)).toEqual(valid);
    expect(() => decodeAgentStartRequestV2({ ...valid, schemaVersion: 1 })).toThrow();
    expect(() => decodeAgentStartRequestV2({ ...valid, executor: 'ssh' })).toThrow();
    expect(() => decodeAgentStartRequestV2({ ...valid, requestedBudgets: null })).toThrow();
  });

  it('checks in separate, closed decision, event, and snapshot schemas', () => {
    expect(AGENT_DECISION_SCHEMA_V2.$id).toBe(
      'https://termbridge.app/protocol/agent/v2/agent-decision.schema.json',
    );
    const decisionVariants = AGENT_DECISION_SCHEMA_V2.oneOf as Record<string, unknown>[];
    expect(decisionVariants).toHaveLength(7);
    for (const variant of decisionVariants) {
      expect(variant.additionalProperties).toBe(false);
      expect((variant.properties as Record<string, { const: number }>).schemaVersion.const).toBe(2);
    }

    expect(AGENT_EVENT_SCHEMA_V2.$id).toBe(
      'https://termbridge.app/protocol/agent/v2/agent-events.schema.json',
    );
    const eventVariants = AGENT_EVENT_SCHEMA_V2.oneOf as Record<string, unknown>[];
    expect(eventVariants).toHaveLength(24);
    for (const variant of eventVariants) {
      expect(variant.additionalProperties).toBe(false);
      expect((variant.properties as Record<string, { const: number }>).schemaVersion.const).toBe(2);
    }

    expect(AGENT_SNAPSHOT_SCHEMA_V2.$id).toBe(
      'https://termbridge.app/protocol/agent/v2/agent-snapshot.schema.json',
    );
    expect(AGENT_SNAPSHOT_SCHEMA_V2.additionalProperties).toBe(false);
    expect(
      (AGENT_SNAPSHOT_SCHEMA_V2.properties as Record<string, { const: number }>).schemaVersion.const,
    ).toBe(2);
  });

  it('compiles all v2 schemas in strict mode and matches every schema fixture expectation', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const schema of [
      AGENT_DECISION_SCHEMA_V2,
      AGENT_EVENT_SCHEMA_V2,
      AGENT_SNAPSHOT_SCHEMA_V2,
    ]) {
      ajv.addSchema(schema);
    }

    for (const [schema, fixture] of [
      [AGENT_DECISION_SCHEMA_V2, decisionFixture],
      [AGENT_EVENT_SCHEMA_V2, eventFixture],
      [AGENT_SNAPSHOT_SCHEMA_V2, snapshotFixture],
    ] as const) {
      const schemaId = schema.$id;
      if (typeof schemaId !== 'string') throw new Error('Schema has no string $id');
      const validate = ajv.getSchema(schemaId);
      if (!validate) throw new Error(`Schema did not compile: ${schemaId}`);
      for (const fixtureCase of fixture.cases as ProtocolCase[]) {
        const value = materialize(fixture.cases as ProtocolCase[], fixtureCase);
        expect(validate(value), fixtureCase.name).toBe(fixtureCase.valid);
      }
    }
  });
});
