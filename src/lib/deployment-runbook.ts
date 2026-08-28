import type {
  DeploymentApprovalPolicyV2,
  DeploymentArtifactUnpackV2,
  DeploymentArtifactV2,
  DeploymentHealthCheckV2,
  DeploymentIdentityV2,
  DeploymentReleaseV2,
  DeploymentRollbackV2,
  DeploymentRunbookDocumentV2,
  DeploymentSecretReferenceV2,
  DeploymentSecurityV2,
  DeploymentServiceActionV2,
  DeploymentServiceV2,
  DeploymentVerificationV2,
  RunbookRisk,
} from '@/types/deployment-runbook';

const MAX_DOCUMENT_LENGTH = 512 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,198}\.service$/;
const DEPLOYMENT_KEYCHAIN_REF_PATTERN = /^keychain:\/\/deployment\/[a-z0-9][a-z0-9._-]{0,63}$/;
const textEncoder = new TextEncoder();

function fail(message: string): never {
  throw new Error(`Deployment Runbook v2: ${message}`);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${field} contains unsupported field ${unknown}`);
}

function stringValue(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (textEncoder.encode(normalized).length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail(`${field} is invalid`);
  }
  return normalized;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} must be boolean`);
  return value;
}

function idValue(value: unknown, field: string): string {
  const normalized = stringValue(value, field, 64);
  if (!ID_PATTERN.test(normalized)) fail(`${field} has an invalid identifier`);
  return normalized;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${field} is invalid`);
  return value as T;
}

function arrayValue(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${field} must contain ${min}-${max} entries`);
  }
  return value;
}

function hasSecretLiteral(value: string): boolean {
  return /(?:password|passphrase|api[_-]?key|secret|token)\s*[=:]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[A-Z0-9]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/i.test(value);
}

function safeText(value: unknown, field: string, max = 4000): string {
  const normalized = stringValue(value, field, max);
  if (hasSecretLiteral(normalized)) fail(`${field} appears to contain a literal secret; use security.secretRefs`);
  return normalized;
}

function absoluteDeploymentPath(value: unknown, field: string): string {
  const path = stringValue(value, field, 1024);
  if (path === '/' || !path.startsWith('/') || path.endsWith('/') || path.includes('//') || path.includes('\\')) {
    fail(`${field} must be a normalized absolute POSIX path below /`);
  }
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment))) {
    fail(`${field} contains an unsafe path segment`);
  }
  return path;
}

function relativeDeploymentPath(value: unknown, field: string, allowDot = false): string {
  const path = stringValue(value, field, 1024);
  if (allowDot && path === '.') return path;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//') || path.includes('\\')) {
    fail(`${field} must be a normalized relative POSIX path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment))) {
    fail(`${field} contains an unsafe path segment`);
  }
  return path;
}

function strictChildOf(child: string, parent: string): boolean {
  return child.startsWith(`${parent}/`);
}

function parseSourceUri(value: unknown, field: string, schemes: readonly string[]): string {
  const source = safeText(value, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    fail(`${field} is not a valid URI`);
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (!schemes.includes(scheme)) fail(`${field} uses an unsupported scheme`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${field} must not contain credentials, query parameters, or fragments`);
  }
  if ((scheme === 'http' || scheme === 'https') && !parsed.hostname) fail(`${field} must include a host`);
  if (scheme === 'file' && parsed.hostname) fail(`${field} file URIs must not include a remote host`);
  return parsed.toString();
}

function parseDeployment(value: unknown): DeploymentIdentityV2 {
  const field = 'deployment';
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'applicationId', 'environment', 'version'], field);
  const version = stringValue(entry.version, `${field}.version`, 128);
  if (!VERSION_PATTERN.test(version)) fail(`${field}.version is invalid`);
  return {
    id: idValue(entry.id, `${field}.id`),
    applicationId: idValue(entry.applicationId, `${field}.applicationId`),
    environment: idValue(entry.environment, `${field}.environment`),
    version,
  };
}

function parseUnpack(value: unknown, field: string): DeploymentArtifactUnpackV2 {
  const entry = objectValue(value, field);
  exactKeys(entry, ['format', 'destinationPath', 'stripComponents'], field);
  return {
    format: enumValue(entry.format, ['tar', 'tarGz', 'zip'] as const, `${field}.format`),
    destinationPath: relativeDeploymentPath(entry.destinationPath, `${field}.destinationPath`, true),
    stripComponents: integerValue(entry.stripComponents, `${field}.stripComponents`, 0, 16),
  };
}

function parseArtifact(value: unknown, index: number): DeploymentArtifactV2 {
  const field = `artifacts[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, [
    'id', 'description', 'kind', 'sourceUri', 'sha256', 'targetPath', 'sizeBytes',
    'credentialRef', 'unpack',
  ], field);
  const kind = enumValue(entry.kind, ['file', 'archive'] as const, `${field}.kind`);
  const sha256 = stringValue(entry.sha256, `${field}.sha256`, 64);
  if (!SHA256_PATTERN.test(sha256)) fail(`${field}.sha256 must be a lowercase SHA-256 digest`);
  const unpack = entry.unpack === undefined ? undefined : parseUnpack(entry.unpack, `${field}.unpack`);
  if (kind === 'archive' && !unpack) fail(`${field}.unpack is required for archive artifacts`);
  if (kind === 'file' && unpack) fail(`${field}.unpack is not allowed for file artifacts`);
  const sizeBytes = entry.sizeBytes === undefined
    ? undefined
    : integerValue(entry.sizeBytes, `${field}.sizeBytes`, 1, 10_000_000_000_000);
  const credentialRef = entry.credentialRef === undefined
    ? undefined
    : idValue(entry.credentialRef, `${field}.credentialRef`);
  return {
    id: idValue(entry.id, `${field}.id`),
    description: safeText(entry.description, `${field}.description`),
    kind,
    sourceUri: parseSourceUri(entry.sourceUri, `${field}.sourceUri`, ['https', 'file']),
    sha256,
    targetPath: relativeDeploymentPath(entry.targetPath, `${field}.targetPath`),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(unpack === undefined ? {} : { unpack }),
  };
}

function parseRelease(value: unknown, deploymentId: string): DeploymentReleaseV2 {
  const field = 'release';
  const entry = objectValue(value, field);
  exactKeys(entry, [
    'rootDirectory', 'releasesDirectory', 'releaseDirectory', 'activeSymlink', 'activationStrategy',
  ], field);
  const result: DeploymentReleaseV2 = {
    rootDirectory: absoluteDeploymentPath(entry.rootDirectory, `${field}.rootDirectory`),
    releasesDirectory: absoluteDeploymentPath(entry.releasesDirectory, `${field}.releasesDirectory`),
    releaseDirectory: absoluteDeploymentPath(entry.releaseDirectory, `${field}.releaseDirectory`),
    activeSymlink: absoluteDeploymentPath(entry.activeSymlink, `${field}.activeSymlink`),
    activationStrategy: enumValue(
      entry.activationStrategy,
      ['atomicSymlinkSwap'] as const,
      `${field}.activationStrategy`,
    ),
  };
  if (!strictChildOf(result.releasesDirectory, result.rootDirectory)) {
    fail(`${field}.releasesDirectory must be below rootDirectory`);
  }
  if (!strictChildOf(result.releaseDirectory, result.releasesDirectory)) {
    fail(`${field}.releaseDirectory must be below releasesDirectory`);
  }
  const releaseSegments = result.releaseDirectory.split('/');
  if (releaseSegments[releaseSegments.length - 1] !== deploymentId) {
    fail(`${field}.releaseDirectory must end with deployment.id`);
  }
  if (!strictChildOf(result.activeSymlink, result.rootDirectory)
    || strictChildOf(result.activeSymlink, result.releasesDirectory)) {
    fail(`${field}.activeSymlink must be below rootDirectory and outside releasesDirectory`);
  }
  return result;
}

function parseService(value: unknown, index: number): DeploymentServiceV2 {
  const field = `services[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'manager', 'unit'], field);
  const unit = stringValue(entry.unit, `${field}.unit`, 200);
  if (!SYSTEMD_UNIT_PATTERN.test(unit)) fail(`${field}.unit is not a valid systemd service unit`);
  return {
    id: idValue(entry.id, `${field}.id`),
    manager: enumValue(entry.manager, ['systemd'] as const, `${field}.manager`),
    unit,
  };
}

function parseRisk(value: unknown, field: string): RunbookRisk {
  return enumValue(value, ['readOnly', 'stateChange', 'destructive'] as const, field);
}

function riskRank(value: RunbookRisk): number {
  return { readOnly: 0, stateChange: 1, destructive: 2 }[value];
}

function parseServiceAction(value: unknown, field: string): DeploymentServiceActionV2 {
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'serviceId', 'action', 'risk', 'timeoutSeconds'], field);
  const risk = parseRisk(entry.risk, `${field}.risk`);
  if (riskRank(risk) < riskRank('stateChange')) {
    fail(`${field}.risk understates a mutating service action`);
  }
  return {
    id: idValue(entry.id, `${field}.id`),
    serviceId: idValue(entry.serviceId, `${field}.serviceId`),
    action: enumValue(entry.action, ['start', 'restart', 'reload'] as const, `${field}.action`),
    risk,
    timeoutSeconds: integerValue(entry.timeoutSeconds, `${field}.timeoutSeconds`, 1, 300),
  };
}

function parseHealthCheck(value: unknown, index: number): DeploymentHealthCheckV2 {
  const field = `verification.checks[${index}]`;
  const entry = objectValue(value, field);
  const kind = enumValue(entry.kind, ['http', 'service'] as const, `${field}.kind`);
  const id = idValue(entry.id, `${field}.id`);
  const timeoutSeconds = integerValue(entry.timeoutSeconds, `${field}.timeoutSeconds`, 1, 300);
  const attempts = integerValue(entry.attempts, `${field}.attempts`, 1, 60);
  const intervalSeconds = integerValue(entry.intervalSeconds, `${field}.intervalSeconds`, 1, 300);
  if (kind === 'http') {
    exactKeys(entry, [
      'id', 'kind', 'url', 'expectedStatus', 'timeoutSeconds', 'attempts', 'intervalSeconds',
    ], field);
    return {
      id,
      kind,
      url: parseSourceUri(entry.url, `${field}.url`, ['http', 'https']),
      expectedStatus: integerValue(entry.expectedStatus, `${field}.expectedStatus`, 200, 399),
      timeoutSeconds,
      attempts,
      intervalSeconds,
    };
  }
  exactKeys(entry, [
    'id', 'kind', 'serviceId', 'expectedState', 'timeoutSeconds', 'attempts', 'intervalSeconds',
  ], field);
  return {
    id,
    kind,
    serviceId: idValue(entry.serviceId, `${field}.serviceId`),
    expectedState: enumValue(entry.expectedState, ['active'] as const, `${field}.expectedState`),
    timeoutSeconds,
    attempts,
    intervalSeconds,
  };
}

function parseVerification(value: unknown): DeploymentVerificationV2 {
  const field = 'verification';
  const entry = objectValue(value, field);
  exactKeys(entry, ['checks'], field);
  return {
    checks: arrayValue(entry.checks, `${field}.checks`, 1, 16).map(parseHealthCheck),
  };
}

function parseRollback(value: unknown): DeploymentRollbackV2 {
  const field = 'rollback';
  const entry = objectValue(value, field);
  exactKeys(entry, ['strategy', 'serviceActions', 'verificationCheckIds'], field);
  return {
    strategy: enumValue(
      entry.strategy,
      ['reactivatePreviousRelease'] as const,
      `${field}.strategy`,
    ),
    serviceActions: arrayValue(entry.serviceActions, `${field}.serviceActions`, 0, 32)
      .map((item, index) => parseServiceAction(item, `${field}.serviceActions[${index}]`)),
    verificationCheckIds: arrayValue(entry.verificationCheckIds, `${field}.verificationCheckIds`, 1, 16)
      .map((item, index) => idValue(item, `${field}.verificationCheckIds[${index}]`)),
  };
}

function parseSecretRef(value: unknown, index: number): DeploymentSecretReferenceV2 {
  const field = `security.secretRefs[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'keychainRef'], field);
  const keychainRef = stringValue(entry.keychainRef, `${field}.keychainRef`, 128);
  if (!DEPLOYMENT_KEYCHAIN_REF_PATTERN.test(keychainRef)) {
    fail(`${field}.keychainRef must be an opaque deployment keychain reference`);
  }
  return { id: idValue(entry.id, `${field}.id`), keychainRef };
}

function parseApproval(value: unknown): DeploymentApprovalPolicyV2 {
  const field = 'security.approval';
  const entry = objectValue(value, field);
  exactKeys(entry, ['deployment', 'rollback', 'destructive', 'targetBinding'], field);
  return {
    deployment: enumValue(entry.deployment, ['explicit'] as const, `${field}.deployment`),
    rollback: enumValue(entry.rollback, ['separate'] as const, `${field}.rollback`),
    destructive: enumValue(
      entry.destructive,
      ['doubleConfirmation'] as const,
      `${field}.destructive`,
    ),
    targetBinding: enumValue(entry.targetBinding, ['frozenProfile'] as const, `${field}.targetBinding`),
  };
}

function parseSecurity(value: unknown): DeploymentSecurityV2 {
  const field = 'security';
  const entry = objectValue(value, field);
  exactKeys(entry, ['declaredRisk', 'allowPrivilegeEscalation', 'approval', 'secretRefs'], field);
  return {
    declaredRisk: parseRisk(entry.declaredRisk, `${field}.declaredRisk`),
    allowPrivilegeEscalation: booleanValue(
      entry.allowPrivilegeEscalation,
      `${field}.allowPrivilegeEscalation`,
    ),
    approval: parseApproval(entry.approval),
    secretRefs: arrayValue(entry.secretRefs, `${field}.secretRefs`, 0, 16).map(parseSecretRef),
  };
}

function uniqueIds(values: readonly { id: string }[], field: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) fail(`${field} contains duplicate id ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateReferences(document: DeploymentRunbookDocumentV2): void {
  uniqueIds(document.artifacts, 'artifacts');
  const targetPaths = new Set<string>();
  for (const artifact of document.artifacts) {
    if (targetPaths.has(artifact.targetPath)) fail(`artifacts contains duplicate targetPath ${artifact.targetPath}`);
    targetPaths.add(artifact.targetPath);
  }

  const serviceIds = uniqueIds(document.services, 'services');
  const forwardActionIds = uniqueIds(document.serviceActions, 'serviceActions');
  const rollbackActionIds = uniqueIds(document.rollback.serviceActions, 'rollback.serviceActions');
  for (const action of [...document.serviceActions, ...document.rollback.serviceActions]) {
    if (!serviceIds.has(action.serviceId)) fail(`service action ${action.id} references unknown service ${action.serviceId}`);
  }
  for (const actionId of rollbackActionIds) {
    if (forwardActionIds.has(actionId)) fail(`rollback service action id ${actionId} must be distinct`);
  }

  const forwardServices = new Set(document.serviceActions.map((action) => action.serviceId));
  const rollbackServices = new Set(document.rollback.serviceActions.map((action) => action.serviceId));
  if (!sameSet(forwardServices, rollbackServices)) {
    fail('rollback.serviceActions must cover exactly the services changed by serviceActions');
  }

  const healthIds = uniqueIds(document.verification.checks, 'verification.checks');
  for (const check of document.verification.checks) {
    if (check.kind === 'service' && !serviceIds.has(check.serviceId)) {
      fail(`health check ${check.id} references unknown service ${check.serviceId}`);
    }
  }
  const rollbackHealthIds = new Set(document.rollback.verificationCheckIds);
  if (rollbackHealthIds.size !== document.rollback.verificationCheckIds.length
    || !sameSet(healthIds, rollbackHealthIds)) {
    fail('rollback.verificationCheckIds must reference every declared health check exactly once');
  }

  const secretIds = uniqueIds(document.security.secretRefs, 'security.secretRefs');
  for (const artifact of document.artifacts) {
    if (artifact.credentialRef && !secretIds.has(artifact.credentialRef)) {
      fail(`artifact ${artifact.id} references unknown credential ${artifact.credentialRef}`);
    }
  }

  const detectedRisk = [...document.serviceActions, ...document.rollback.serviceActions]
    .reduce<RunbookRisk>(
      (highest, action) => riskRank(action.risk) > riskRank(highest) ? action.risk : highest,
      'stateChange',
    );
  if (riskRank(document.security.declaredRisk) < riskRank(detectedRisk)) {
    fail(`security.declaredRisk understates detected ${detectedRisk} deployment behavior`);
  }
}

export function parseDeploymentRunbookV2Text(text: string): DeploymentRunbookDocumentV2 {
  if (!text.trim()) fail('text is empty');
  if (textEncoder.encode(text).length > MAX_DOCUMENT_LENGTH) fail('text exceeds 512 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('text is not valid JSON');
  }
  const entry = objectValue(value, 'document');
  exactKeys(entry, [
    'schemaVersion', 'kind', 'id', 'name', 'description', 'deployment', 'artifacts', 'release',
    'services', 'serviceActions', 'verification', 'rollback', 'security',
  ], 'document');
  if (entry.schemaVersion !== 2) fail('schemaVersion must be 2');
  if (entry.kind !== 'deployment') fail('kind must be deployment');
  const deployment = parseDeployment(entry.deployment);
  const document: DeploymentRunbookDocumentV2 = {
    schemaVersion: 2,
    kind: 'deployment',
    id: idValue(entry.id, 'id'),
    name: safeText(entry.name, 'name', 200),
    description: safeText(entry.description, 'description'),
    deployment,
    artifacts: arrayValue(entry.artifacts, 'artifacts', 1, 16).map(parseArtifact),
    release: parseRelease(entry.release, deployment.id),
    services: arrayValue(entry.services, 'services', 0, 16).map(parseService),
    serviceActions: arrayValue(entry.serviceActions, 'serviceActions', 0, 32)
      .map((item, index) => parseServiceAction(item, `serviceActions[${index}]`)),
    verification: parseVerification(entry.verification),
    rollback: parseRollback(entry.rollback),
    security: parseSecurity(entry.security),
  };
  validateReferences(document);
  return document;
}

export function serializeDeploymentRunbookV2(document: DeploymentRunbookDocumentV2): string {
  return `${JSON.stringify(parseDeploymentRunbookV2Text(JSON.stringify(document)), null, 2)}\n`;
}
