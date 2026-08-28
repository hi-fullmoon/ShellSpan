import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import actionFixture from '../../../tests/fixtures/agent-terminal-protocol/v1/terminal-actions.json';
import safetyFixture from '../../../tests/fixtures/agent-terminal-protocol/v1/terminal-safety.json';
import {
  MAX_TERMINAL_ACTION_BYTES_V1,
  TERMINAL_ACTION_SCHEMA_V1,
  decodeTerminalActionV1,
} from '@/lib/agent-terminal-protocol';
import { decodeAgentDecisionV1 } from '@/lib/agent-protocol';
import { decodeAgentDecisionV2 } from '@/lib/agent-protocol-v2';

interface ActionFixtureCase {
  name: string;
  valid: boolean;
  value: unknown;
}

describe('Agent terminal semantic protocol v1', () => {
  it('strictly decodes every shared Rust/TypeScript action fixture', () => {
    expect(actionFixture.schemaVersion).toBe(1);
    for (const fixtureCase of actionFixture.cases as ActionFixtureCase[]) {
      const decode = () => decodeTerminalActionV1(JSON.stringify(fixtureCase.value));
      if (fixtureCase.valid) {
        expect(decode(), fixtureCase.name).toEqual(fixtureCase.value);
      } else {
        expect(decode, fixtureCase.name).toThrow();
      }
    }
  });

  it('compiles the closed schema and matches every shared fixture expectation', () => {
    expect(TERMINAL_ACTION_SCHEMA_V1.$id).toBe(
      'https://termbridge.app/protocol/agent-terminal/v1/terminal-actions.schema.json',
    );
    const variants = TERMINAL_ACTION_SCHEMA_V1.oneOf as Record<string, unknown>[];
    expect(variants).toHaveLength(4);
    for (const variant of variants) expect(variant.additionalProperties).toBe(false);

    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      TERMINAL_ACTION_SCHEMA_V1,
    );
    for (const fixtureCase of actionFixture.cases as ActionFixtureCase[]) {
      expect(validate(fixtureCase.value), fixtureCase.name).toBe(fixtureCase.valid);
    }
  });

  it('keeps terminal actions outside the frozen Agent v1/v2 decision unions', () => {
    for (const fixtureCase of (actionFixture.cases as ActionFixtureCase[]).filter(
      (entry) => entry.valid,
    )) {
      const raw = JSON.stringify(fixtureCase.value);
      expect(() => decodeAgentDecisionV1(raw), fixtureCase.name).toThrow();
      expect(() => decodeAgentDecisionV2(raw), fixtureCase.name).toThrow();
    }
  });

  it('rejects oversized model messages before decoding', () => {
    const oversized = JSON.stringify({
      schemaVersion: 1,
      action: 'terminal.respond',
      actionId: 'a'.repeat(MAX_TERMINAL_ACTION_BYTES_V1),
      observationId: 'observation-1',
      response: 'accept',
    });
    expect(() => decodeTerminalActionV1(oversized)).toThrowError(/16 KiB/);
  });

  it('shares the backend safety corpus without projecting policy authority to TypeScript', () => {
    expect(safetyFixture.schemaVersion).toBe(1);
    const names = safetyFixture.cases.map((fixtureCase) => fixtureCase.name);
    for (const boundary of [
      'password', 'passphrase', 'MFA', 'OTP', 'token', 'credential',
      'full-screen', 'editor', 'stale prompt', 'run mismatch', 'target mismatch',
      'session binding mismatch', 'old lease epoch', 'old lease revision', 'replayed',
    ]) {
      expect(names.some((name) => name.includes(boundary)), boundary).toBe(true);
    }
    for (const fixtureCase of safetyFixture.cases) {
      expect(() => decodeTerminalActionV1(fixtureCase.action), fixtureCase.name).not.toThrow();
      expect(['input', 'handoff', 'deny']).toContain(fixtureCase.expectedOutcome);
    }
  });

  it('fails closed for a fixed-seed unknown-field enum and size property corpus', () => {
    let seed = 0xa11c_e55;
    const next = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed;
    };
    const valid = (actionFixture.cases as ActionFixtureCase[])
      .filter((entry) => entry.valid)
      .map((entry) => entry.value as Record<string, unknown>);
    for (let index = 0; index < 384; index += 1) {
      const base = structuredClone(valid[next() % valid.length]);
      const mutation = next() % 3;
      if (mutation === 0) {
        base[`unknown${next()}`] = 'must-fail-closed';
      } else if (mutation === 1) {
        base.action = `terminal.unknown${next()}`;
      } else {
        base.actionId = 'a'.repeat(MAX_TERMINAL_ACTION_BYTES_V1 + (next() % 32));
      }
      expect(
        () => decodeTerminalActionV1(JSON.stringify(base)),
        `seeded mutation ${index}`,
      ).toThrow();
    }
  });
});
