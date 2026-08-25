import { describe, expect, it } from 'vitest';
import {
  createRunbookJsonSchema,
  RUNBOOK_SCHEMA_URI,
  runbookVariableNames,
} from '@/lib/runbook-schema';
import { RUNBOOK_EXAMPLE } from '@/lib/runbook';

describe('runbook editor schema', () => {
  it('models the closed v1 document contract and its safety-sensitive enums', () => {
    const RUNBOOK_JSON_SCHEMA = createRunbookJsonSchema((key) => key);
    expect(RUNBOOK_JSON_SCHEMA.$id).toBe(RUNBOOK_SCHEMA_URI);
    expect(RUNBOOK_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(RUNBOOK_JSON_SCHEMA.required).toEqual(expect.arrayContaining([
      'schemaVersion',
      'variables',
      'prechecks',
      'steps',
    ]));

    const properties = RUNBOOK_JSON_SCHEMA.properties ?? {};
    expect(properties.schemaVersion).toMatchObject({ const: 1 });
    expect(properties.evidenceMaxAgeSeconds).toMatchObject({ minimum: 30, maximum: 3600 });
    expect(properties.prechecks).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(properties.steps).toMatchObject({ maxItems: 64 });

    const steps = properties.steps;
    expect(steps).toBeTruthy();
    expect(typeof steps).toBe('object');
    if (!steps || typeof steps !== 'object') throw new Error('steps schema is missing');
    const step = Array.isArray(steps.items) ? steps.items[0] : steps.items;
    expect(step && typeof step === 'object' ? step.properties?.risk : undefined).toMatchObject({
      enum: ['readOnly', 'stateChange', 'destructive'],
    });
  });

  it('offers declared variables to command placeholder completion', () => {
    expect(runbookVariableNames(RUNBOOK_EXAMPLE)).toEqual(['SERVICE']);
    expect(runbookVariableNames('{')).toEqual([]);
    expect(runbookVariableNames(JSON.stringify({
      variables: [{ name: 'SERVICE' }, { name: 'SERVICE' }, { name: 'not-valid' }, null],
    }))).toEqual(['SERVICE']);
  });
});
