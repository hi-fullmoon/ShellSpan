import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import fixture from '../../../tests/fixtures/deployment-runbook/v2/deployment-runbooks.json';
import schema from '../../../protocol/runbook/v2/deployment-runbook.schema.json';
import example from '../../../docs/examples/deployment-runbook-v2.runbook.json';
import {
  parseDeploymentRunbookV2Text,
  serializeDeploymentRunbookV2,
} from '@/lib/deployment-runbook';

interface DeploymentFixtureCase {
  name: string;
  valid: boolean;
  value?: unknown;
  deriveFrom?: number;
  patch?: Record<string, unknown>;
}

function applyPatch(root: object, path: string, replacement: unknown): void {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = replacement;
  else (current as Record<string, unknown>)[last] = replacement;
}

function materialize(cases: readonly DeploymentFixtureCase[], fixtureCase: DeploymentFixtureCase): unknown {
  const source = fixtureCase.deriveFrom === undefined
    ? fixtureCase.value
    : cases[fixtureCase.deriveFrom]?.value;
  const value = structuredClone(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid fixture base: ${fixtureCase.name}`);
  }
  for (const [path, replacement] of Object.entries(fixtureCase.patch ?? {})) {
    applyPatch(value, path, replacement);
  }
  return value;
}

describe('Deployment Runbook v2 contract', () => {
  const cases = fixture.cases as DeploymentFixtureCase[];

  it('strictly validates the shared cross-language fixture matrix', () => {
    for (const fixtureCase of cases) {
      const value = materialize(cases, fixtureCase);
      const parse = () => parseDeploymentRunbookV2Text(JSON.stringify(value));
      if (fixtureCase.valid) {
        expect(parse, fixtureCase.name).not.toThrow();
        expect(parse(), fixtureCase.name).toEqual(value);
      } else {
        expect(parse, fixtureCase.name).toThrow();
      }
    }
  });

  it('normalizes serialization deterministically and validates before writing', () => {
    const value = materialize(cases, cases[0]);
    const source = JSON.stringify(value).replace(
      '"name":"Deploy Acme API to production"',
      '"name":"  Deploy Acme API to production  "',
    );
    const parsed = parseDeploymentRunbookV2Text(source);
    const first = serializeDeploymentRunbookV2(parsed);
    const second = serializeDeploymentRunbookV2(parseDeploymentRunbookV2Text(first));

    expect(first).toBe(second);
    expect(first).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(() => serializeDeploymentRunbookV2({
      ...parsed,
      security: { ...parsed.security, declaredRisk: 'readOnly' },
    })).toThrow(/understates/);
  });

  it('rejects the removed v1 format instead of treating it as a deployment migration', () => {
    const v1Text = JSON.stringify(fixture.v1Document);
    expect(() => parseDeploymentRunbookV2Text(v1Text)).toThrow(/unsupported field|schemaVersion/);
  });

  it('publishes a fail-closed JSON Schema for structural editor validation', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const valid = materialize(cases, cases[0]);
    const unknown = materialize(cases, cases[1]);

    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(unknown)).toBe(false);
  });

  it('keeps the documented example valid and canonical', () => {
    const parsed = parseDeploymentRunbookV2Text(JSON.stringify(example));
    expect(serializeDeploymentRunbookV2(parsed)).toBe(`${JSON.stringify(example, null, 2)}\n`);
  });
});
