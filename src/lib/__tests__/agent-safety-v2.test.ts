import { describe, expect, it } from 'vitest';
import safetyFixture from '../../../tests/fixtures/agent-protocol/v2/risk-evidence-preconditions.json';
import {
  AgentSafetyProjectionErrorV2,
  decodeAgentEffectivePolicyV2,
  decodeAgentEvidenceFreshnessPolicyV2,
  decodeAgentLocalRiskProjectionV2,
  decodeAgentPreconditionErrorV2,
  decodeAgentPreconditionValidationV2,
  decodeAgentServiceCapabilityEvidenceV2,
  decodeAgentStructuredEvidenceV2,
} from '@/lib/agent-safety-v2';

describe('Agent P2-A backend-authoritative safety projections', () => {
  it('consumes the shared freshness, policy, evidence, precondition, and risk fixture', () => {
    expect(safetyFixture.schemaVersion).toBe(2);
    expect(decodeAgentEvidenceFreshnessPolicyV2(safetyFixture.freshnessPolicy)).toEqual({
      serviceStatusSeconds: 120,
      configValidationSeconds: 120,
      listenerSeconds: 60,
      targetCapabilitySeconds: 300,
    });
    expect(safetyFixture.freshnessCases).toEqual([
      { class: 'serviceStatus', ageMillis: 120000, expectedFresh: true },
      { class: 'serviceStatus', ageMillis: 120001, expectedFresh: false },
      { class: 'configValidation', ageMillis: 120000, expectedFresh: true },
      { class: 'configValidation', ageMillis: 120001, expectedFresh: false },
      { class: 'listener', ageMillis: 60000, expectedFresh: true },
      { class: 'listener', ageMillis: 60001, expectedFresh: false },
      { class: 'targetCapability', ageMillis: 300000, expectedFresh: true },
      { class: 'targetCapability', ageMillis: 300001, expectedFresh: false },
    ]);
    for (const fixtureCase of safetyFixture.effectivePolicyCases) {
      expect(decodeAgentEffectivePolicyV2(fixtureCase.expected), fixtureCase.name).toEqual(
        fixtureCase.expected,
      );
    }
    for (const evidence of safetyFixture.structuredEvidenceProjections) {
      expect(decodeAgentStructuredEvidenceV2(evidence)).toEqual(evidence);
    }
    expect(decodeAgentServiceCapabilityEvidenceV2(safetyFixture.capabilityProjection)).toEqual(
      safetyFixture.capabilityProjection,
    );
    expect(
      decodeAgentPreconditionValidationV2(safetyFixture.preconditionValidationProjection),
    ).toEqual(safetyFixture.preconditionValidationProjection);
    for (const error of safetyFixture.preconditionErrorProjections) {
      expect(decodeAgentPreconditionErrorV2(error)).toEqual(error);
    }
    expect(decodeAgentLocalRiskProjectionV2(safetyFixture.riskProjection)).toEqual(
      safetyFixture.riskProjection,
    );
  });

  it('keeps the documented action matrix and deny corpus visible to TypeScript tests', () => {
    expect(safetyFixture.preconditionCases.map((fixtureCase) => fixtureCase.name)).toEqual(
      expect.arrayContaining([
        'start-loaded-inactive-valid-config',
        'reload-active-valid-config',
        'restart-explicit-failed-valid-config',
        'stop-requires-explicit-user-goal',
        'status-over-120-seconds-is-stale',
        'capability-over-five-minutes-is-stale',
      ]),
    );
    expect(safetyFixture.ownershipCases.map((fixtureCase) => fixtureCase.expected)).toEqual([
      'runMismatch',
      'targetMismatch',
      'resourceMismatch',
    ]);
    expect(safetyFixture.riskCases.filter((fixtureCase) => fixtureCase.expectedVerdict === 'deny'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'unknownToolOrAction' }),
        expect.objectContaining({ operation: 'destructive' }),
        expect.objectContaining({ operation: 'privilegeElevation' }),
        expect.objectContaining({ operation: 'shellInterpretation' }),
        expect.objectContaining({ operation: 'multiHost' }),
        expect.objectContaining({ operation: 'credentialAccess' }),
        expect.objectContaining({ operation: 'externalDownloadExecute' }),
        expect.objectContaining({ operation: 'networkChange' }),
        expect.objectContaining({ operation: 'ambiguousResource' }),
      ]));
    for (const fixtureCase of safetyFixture.riskCases) {
      if (fixtureCase.modelClaimsReadOnly && fixtureCase.operation !== 'unknownToolOrAction') {
        expect(fixtureCase.expectedVerdict, fixtureCase.name).not.toBe('autoReadOnly');
      }
    }
  });

  it('fails closed on forged fields, mixed claims, target drift, and policy weakening', () => {
    const status = safetyFixture.structuredEvidenceProjections[0];
    expect(() => decodeAgentStructuredEvidenceV2({ ...status, command: 'systemctl start nginx' }))
      .toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentStructuredEvidenceV2({
      ...status,
      claims: { ...status.claims, configValid: true },
    })).toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentStructuredEvidenceV2({
      ...status,
      targetDigest: 'sha256-v1:other-target',
    })).toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentEvidenceFreshnessPolicyV2({
      ...safetyFixture.freshnessPolicy,
      serviceStatusSeconds: 301,
    })).toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentEffectivePolicyV2({
      ...safetyFixture.effectivePolicyCases[0].expected,
      mutationRequiresApproval: false,
    })).toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentEffectivePolicyV2({
      ...safetyFixture.effectivePolicyCases[1].expected,
      readOnlyRequiresApproval: false,
    })).toThrow(AgentSafetyProjectionErrorV2);
    expect(() => decodeAgentServiceCapabilityEvidenceV2({
      ...safetyFixture.capabilityProjection,
      targetCapability: 'unknown',
    })).toThrow(AgentSafetyProjectionErrorV2);
  });
});
