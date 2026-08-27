import {
  decodeAgentResourceRefV2,
  decodeAgentRiskAssessmentV2,
} from '@/lib/agent-protocol-v2';
import type {
  AgentEffectivePolicyV2,
  AgentEvidenceFreshnessPolicyV2,
  AgentPreconditionErrorCategoryV2,
  AgentPreconditionErrorV2,
  AgentPreconditionFailureReasonV2,
  AgentPreconditionValidationV2,
  AgentRiskAssessmentV2,
  AgentServiceCapabilityEvidenceV2,
  AgentStructuredEvidenceV2,
  AgentStructuredServiceClaimsV2,
  ServiceControlActionV2,
} from '@/types/agent-v2';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SERVICE_ACTIONS = ['start', 'reload', 'restart', 'stop'] as const;
const PRECONDITION_REASONS = [
  'runMismatch',
  'targetMismatch',
  'resourceMismatch',
  'capabilityMissing',
  'capabilityUnsupported',
  'capabilityStale',
  'actionUnsupported',
  'evidenceMissing',
  'evidenceUnknown',
  'evidenceFailed',
  'evidenceStale',
  'evidenceDigestChanged',
  'conflictingClaims',
  'statusEvidenceRequired',
  'configEvidenceRequired',
  'configValidatorMismatch',
  'unitNotLoaded',
  'unitAlreadyActive',
  'unitNotActive',
  'unitNotActiveOrFailed',
  'configInvalid',
  'stopIntentMissing',
] as const satisfies readonly AgentPreconditionFailureReasonV2[];

export class AgentSafetyProjectionErrorV2 extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'AgentSafetyProjectionErrorV2';
  }
}

function fail(field: string, message: string): never {
  throw new AgentSafetyProjectionErrorV2(message, field);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(field, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(field, `${field} contains unknown field ${unknown}`);
}

function textValue(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || [...value].length > max
    || value.includes('\0')
  ) {
    return fail(field, `${field} is invalid`);
  }
  return value;
}

function identifierValue(value: unknown, field: string): string {
  const identifier = textValue(value, field, 64);
  if (!IDENTIFIER.test(identifier)) return fail(field, `${field} is not an identifier`);
  return identifier;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return fail(field, `${field} must be boolean`);
  return value;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail(field, `${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return fail(field, `${field} contains an unknown enum value`);
  }
  return value as T;
}

function arrayValue(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return fail(field, `${field} must contain ${min}-${max} items`);
  }
  return value;
}

function decodeClaimsV2(value: unknown): AgentStructuredServiceClaimsV2 {
  const claims = objectValue(value, 'claims');
  exactKeys(
    claims,
    ['loadState', 'activeState', 'subState', 'configValid', 'listeningPorts'],
    'claims',
  );
  const decoded: AgentStructuredServiceClaimsV2 = {};
  for (const key of ['loadState', 'activeState', 'subState'] as const) {
    if (claims[key] !== undefined) decoded[key] = textValue(claims[key], `claims.${key}`, 128);
  }
  if (claims.configValid !== undefined) {
    decoded.configValid = booleanValue(claims.configValid, 'claims.configValid');
  }
  if (claims.listeningPorts !== undefined) {
    const ports = arrayValue(claims.listeningPorts, 'claims.listeningPorts', 128).map(
      (port, index) => integerValue(port, `claims.listeningPorts[${index}]`, 1, 65_535),
    );
    if (new Set(ports).size !== ports.length || ports.some((port, index) => index > 0 && port <= ports[index - 1])) {
      fail('claims.listeningPorts', 'listener ports must be unique and sorted');
    }
    decoded.listeningPorts = ports;
  }
  const classes = [
    decoded.loadState !== undefined || decoded.activeState !== undefined || decoded.subState !== undefined,
    decoded.configValid !== undefined,
    decoded.listeningPorts !== undefined,
  ].filter(Boolean).length;
  if (classes !== 1) fail('claims', 'claims must contain exactly one evidence class');
  return decoded;
}

export function decodeAgentStructuredEvidenceV2(value: unknown): AgentStructuredEvidenceV2 {
  const evidence = objectValue(value, 'structuredEvidence');
  exactKeys(
    evidence,
    [
      'evidenceId', 'runId', 'targetDigest', 'resource', 'observedAt', 'successful',
      'claims', 'observationDigest',
    ],
    'structuredEvidence',
  );
  const resource = decodeAgentResourceRefV2(evidence.resource);
  const targetDigest = textValue(evidence.targetDigest, 'structuredEvidence.targetDigest');
  if (resource.targetDigest !== targetDigest) {
    fail('structuredEvidence.resource', 'resource target must match evidence target');
  }
  return {
    evidenceId: identifierValue(evidence.evidenceId, 'structuredEvidence.evidenceId'),
    runId: identifierValue(evidence.runId, 'structuredEvidence.runId'),
    targetDigest,
    resource,
    observedAt: integerValue(evidence.observedAt, 'structuredEvidence.observedAt', 0, Number.MAX_SAFE_INTEGER),
    successful: booleanValue(evidence.successful, 'structuredEvidence.successful'),
    claims: decodeClaimsV2(evidence.claims),
    observationDigest: textValue(evidence.observationDigest, 'structuredEvidence.observationDigest'),
  };
}

export function decodeAgentServiceCapabilityEvidenceV2(
  value: unknown,
): AgentServiceCapabilityEvidenceV2 {
  const evidence = objectValue(value, 'capabilityEvidence');
  exactKeys(
    evidence,
    [
      'evidenceId', 'runId', 'targetDigest', 'resource', 'observedAt', 'successful',
      'targetCapability', 'supportedActions', 'validator', 'reloadMayInterrupt',
      'capabilityDigest',
    ],
    'capabilityEvidence',
  );
  const resource = decodeAgentResourceRefV2(evidence.resource);
  const targetDigest = textValue(evidence.targetDigest, 'capabilityEvidence.targetDigest');
  if (resource.targetDigest !== targetDigest) {
    fail('capabilityEvidence.resource', 'resource target must match capability target');
  }
  const supportedActions = arrayValue(evidence.supportedActions, 'capabilityEvidence.supportedActions', 4)
    .map((action, index) => enumValue<ServiceControlActionV2>(
      action,
      SERVICE_ACTIONS,
      `capabilityEvidence.supportedActions[${index}]`,
    ));
  if (new Set(supportedActions).size !== supportedActions.length) {
    fail('capabilityEvidence.supportedActions', 'supported actions contain duplicates');
  }
  if (supportedActions.some((action, index) => (
    index > 0
    && SERVICE_ACTIONS.indexOf(action) <= SERVICE_ACTIONS.indexOf(supportedActions[index - 1]!)
  ))) {
    fail('capabilityEvidence.supportedActions', 'supported actions are not canonical');
  }
  const targetCapability = enumValue(
    evidence.targetCapability,
    ['posixSystemd', 'unsupported', 'unknown'] as const,
    'capabilityEvidence.targetCapability',
  );
  const reloadMayInterrupt = booleanValue(
    evidence.reloadMayInterrupt,
    'capabilityEvidence.reloadMayInterrupt',
  );
  const validator = evidence.validator === undefined
    ? undefined
    : enumValue(evidence.validator, ['nginx', 'apache', 'sshd'] as const, 'capabilityEvidence.validator');
  if (
    targetCapability !== 'posixSystemd'
    && (supportedActions.length > 0 || validator !== undefined || reloadMayInterrupt)
  ) {
    fail('capabilityEvidence', 'unsupported targets cannot claim systemd capabilities');
  }
  if (reloadMayInterrupt && !supportedActions.includes('reload')) {
    fail('capabilityEvidence.reloadMayInterrupt', 'reload interruption requires reload support');
  }
  return {
    evidenceId: identifierValue(evidence.evidenceId, 'capabilityEvidence.evidenceId'),
    runId: identifierValue(evidence.runId, 'capabilityEvidence.runId'),
    targetDigest,
    resource,
    observedAt: integerValue(evidence.observedAt, 'capabilityEvidence.observedAt', 0, Number.MAX_SAFE_INTEGER),
    successful: booleanValue(evidence.successful, 'capabilityEvidence.successful'),
    targetCapability,
    supportedActions,
    ...(validator === undefined ? {} : { validator }),
    reloadMayInterrupt,
    capabilityDigest: textValue(evidence.capabilityDigest, 'capabilityEvidence.capabilityDigest'),
  };
}

export function decodeAgentEvidenceFreshnessPolicyV2(
  value: unknown,
): AgentEvidenceFreshnessPolicyV2 {
  const policy = objectValue(value, 'freshnessPolicy');
  const fields = [
    'serviceStatusSeconds',
    'configValidationSeconds',
    'listenerSeconds',
    'targetCapabilitySeconds',
  ] as const;
  exactKeys(policy, fields, 'freshnessPolicy');
  return {
    serviceStatusSeconds: integerValue(policy.serviceStatusSeconds, 'freshnessPolicy.serviceStatusSeconds', 1, 300),
    configValidationSeconds: integerValue(policy.configValidationSeconds, 'freshnessPolicy.configValidationSeconds', 1, 300),
    listenerSeconds: integerValue(policy.listenerSeconds, 'freshnessPolicy.listenerSeconds', 1, 300),
    targetCapabilitySeconds: integerValue(policy.targetCapabilitySeconds, 'freshnessPolicy.targetCapabilitySeconds', 1, 300),
  };
}

export function decodeAgentEffectivePolicyV2(value: unknown): AgentEffectivePolicyV2 {
  const policy = objectValue(value, 'effectivePolicy');
  exactKeys(
    policy,
    [
      'mode', 'policyVersion', 'readOnlyRequiresApproval', 'mutationRequiresApproval',
      'highImpactRequiresDoubleConfirmation',
    ],
    'effectivePolicy',
  );
  const mutationRequiresApproval = booleanValue(
    policy.mutationRequiresApproval,
    'effectivePolicy.mutationRequiresApproval',
  );
  const highImpactRequiresDoubleConfirmation = booleanValue(
    policy.highImpactRequiresDoubleConfirmation,
    'effectivePolicy.highImpactRequiresDoubleConfirmation',
  );
  if (!mutationRequiresApproval || !highImpactRequiresDoubleConfirmation) {
    fail('effectivePolicy', 'P2 effective policy cannot weaken mutation confirmation');
  }
  const mode = enumValue(policy.mode, ['strict', 'balanced'] as const, 'effectivePolicy.mode');
  const readOnlyRequiresApproval = booleanValue(
    policy.readOnlyRequiresApproval,
    'effectivePolicy.readOnlyRequiresApproval',
  );
  if (readOnlyRequiresApproval !== (mode === 'strict')) {
    fail('effectivePolicy', 'read-only approval must match the resolved effective mode');
  }
  return {
    mode,
    policyVersion: identifierValue(policy.policyVersion, 'effectivePolicy.policyVersion'),
    readOnlyRequiresApproval,
    mutationRequiresApproval: true,
    highImpactRequiresDoubleConfirmation: true,
  };
}

export function decodeAgentPreconditionValidationV2(
  value: unknown,
): AgentPreconditionValidationV2 {
  const validation = objectValue(value, 'preconditionValidation');
  exactKeys(
    validation,
    [
      'runId', 'targetDigest', 'resource', 'action', 'capabilityEvidenceId', 'evidenceIds',
      'evidenceSetDigest', 'validatedAt',
    ],
    'preconditionValidation',
  );
  const resource = decodeAgentResourceRefV2(validation.resource);
  const targetDigest = textValue(validation.targetDigest, 'preconditionValidation.targetDigest');
  if (resource.targetDigest !== targetDigest) {
    fail('preconditionValidation.resource', 'resource target must match validation target');
  }
  const evidenceIds = arrayValue(validation.evidenceIds, 'preconditionValidation.evidenceIds', 32, 1)
    .map((id, index) => identifierValue(id, `preconditionValidation.evidenceIds[${index}]`));
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    fail('preconditionValidation.evidenceIds', 'evidence IDs contain duplicates');
  }
  return {
    runId: identifierValue(validation.runId, 'preconditionValidation.runId'),
    targetDigest,
    resource,
    action: enumValue(validation.action, SERVICE_ACTIONS, 'preconditionValidation.action'),
    capabilityEvidenceId: identifierValue(
      validation.capabilityEvidenceId,
      'preconditionValidation.capabilityEvidenceId',
    ),
    evidenceIds,
    evidenceSetDigest: textValue(validation.evidenceSetDigest, 'preconditionValidation.evidenceSetDigest'),
    validatedAt: integerValue(validation.validatedAt, 'preconditionValidation.validatedAt', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeAgentPreconditionErrorV2(value: unknown): AgentPreconditionErrorV2 {
  const error = objectValue(value, 'preconditionError');
  exactKeys(error, ['category', 'reason'], 'preconditionError');
  return {
    category: enumValue<AgentPreconditionErrorCategoryV2>(
      error.category,
      ['staleEvidence', 'preconditionFailed'],
      'preconditionError.category',
    ),
    reason: enumValue(error.reason, PRECONDITION_REASONS, 'preconditionError.reason'),
  };
}

// Risk remains authored by Rust. This alias keeps consumers on the same strict
// projection decoder already used by v2 events and snapshots.
export function decodeAgentLocalRiskProjectionV2(value: unknown): AgentRiskAssessmentV2 {
  return decodeAgentRiskAssessmentV2(value);
}
