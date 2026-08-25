import { classifyError } from '@/lib/error';
import { t, type LocaleKey } from '@/locales';

export type RunbookErrorCode =
  | 'expectedObject'
  | 'unsupportedField'
  | 'nonEmptyString'
  | 'invalidValue'
  | 'integerRange'
  | 'idFormat'
  | 'variableNameFormat'
  | 'booleanRequired'
  | 'keychainRefUnsupported'
  | 'variableSourceConflict'
  | 'secretVariableNeedsKeychain'
  | 'secretDefault'
  | 'arrayRequired'
  | 'arrayTooLong'
  | 'unboundedStream'
  | 'unsafeBoundedInput'
  | 'mutatingDateOption'
  | 'mutatingHostnameArgument'
  | 'boundedJournalQuery'
  | 'mutatingSocketOption'
  | 'mutatingSystemctlAction'
  | 'understatedRisk'
  | 'readOnlyShellSyntax'
  | 'readOnlyCommand'
  | 'sensitiveLiteral'
  | 'invalidRisk'
  | 'rollbackRequired'
  | 'undeclaredVariable'
  | 'requiredVariable'
  | 'emptyText'
  | 'textTooLarge'
  | 'invalidJson'
  | 'schemaVersion'
  | 'variablesLimit'
  | 'prechecksLimit'
  | 'stepsLimit'
  | 'duplicateVariable'
  | 'duplicateAction'
  | 'actionUndeclaredVariable'
  | 'concurrencyRange'
  | 'batchSizeRange'
  | 'concurrencyExceedsBatch'
  | 'taskIdentityRequired'
  | 'tagHasNoTargets'
  | 'duplicateTarget';

export type RunbookErrorScope = 'runbook' | 'multiHost';
export type RunbookErrorVariables = Record<string, string | number>;
export type RunbookErrorTranslate = (
  key: LocaleKey,
  variables?: RunbookErrorVariables,
) => string;

const errorKeys: Record<RunbookErrorCode, LocaleKey> = {
  expectedObject: 'runbook.error.expectedObject',
  unsupportedField: 'runbook.error.unsupportedField',
  nonEmptyString: 'runbook.error.nonEmptyString',
  invalidValue: 'runbook.error.invalidValue',
  integerRange: 'runbook.error.integerRange',
  idFormat: 'runbook.error.idFormat',
  variableNameFormat: 'runbook.error.variableNameFormat',
  booleanRequired: 'runbook.error.booleanRequired',
  keychainRefUnsupported: 'runbook.error.keychainRefUnsupported',
  variableSourceConflict: 'runbook.error.variableSourceConflict',
  secretVariableNeedsKeychain: 'runbook.error.secretVariableNeedsKeychain',
  secretDefault: 'runbook.error.secretDefault',
  arrayRequired: 'runbook.error.arrayRequired',
  arrayTooLong: 'runbook.error.arrayTooLong',
  unboundedStream: 'runbook.error.unboundedStream',
  unsafeBoundedInput: 'runbook.error.unsafeBoundedInput',
  mutatingDateOption: 'runbook.error.mutatingDateOption',
  mutatingHostnameArgument: 'runbook.error.mutatingHostnameArgument',
  boundedJournalQuery: 'runbook.error.boundedJournalQuery',
  mutatingSocketOption: 'runbook.error.mutatingSocketOption',
  mutatingSystemctlAction: 'runbook.error.mutatingSystemctlAction',
  understatedRisk: 'runbook.error.understatedRisk',
  readOnlyShellSyntax: 'runbook.error.readOnlyShellSyntax',
  readOnlyCommand: 'runbook.error.readOnlyCommand',
  sensitiveLiteral: 'runbook.error.literalSecret',
  invalidRisk: 'runbook.error.invalidRisk',
  rollbackRequired: 'runbook.error.rollbackRequired',
  undeclaredVariable: 'runbook.error.undeclaredVariable',
  requiredVariable: 'runbook.error.requiredVariable',
  emptyText: 'runbook.error.emptyText',
  textTooLarge: 'runbook.error.textTooLarge',
  invalidJson: 'runbook.error.invalidJson',
  schemaVersion: 'runbook.error.schemaVersion',
  variablesLimit: 'runbook.error.variablesLimit',
  prechecksLimit: 'runbook.error.prechecksLimit',
  stepsLimit: 'runbook.error.stepsLimit',
  duplicateVariable: 'runbook.error.duplicateVariable',
  duplicateAction: 'runbook.error.duplicateAction',
  actionUndeclaredVariable: 'runbook.error.actionUndeclaredVariable',
  concurrencyRange: 'runbook.error.concurrencyRange',
  batchSizeRange: 'runbook.error.batchSizeRange',
  concurrencyExceedsBatch: 'runbook.error.concurrencyExceedsBatch',
  taskIdentityRequired: 'runbook.error.taskIdentityRequired',
  tagHasNoTargets: 'runbook.error.tagHasNoTargets',
  duplicateTarget: 'runbook.error.duplicateTarget',
};

export class RunbookError extends Error {
  readonly code: RunbookErrorCode;
  readonly scope: RunbookErrorScope;
  readonly variables: RunbookErrorVariables;

  constructor(
    scope: RunbookErrorScope,
    code: RunbookErrorCode,
    fallbackMessage: string,
    variables: RunbookErrorVariables = {},
  ) {
    super(`${scope === 'multiHost' ? 'Multi-host Runbook' : 'Runbook'}: ${fallbackMessage}`);
    this.name = 'RunbookError';
    this.scope = scope;
    this.code = code;
    this.variables = variables;
  }
}

export function throwRunbookError(
  scope: RunbookErrorScope,
  code: RunbookErrorCode,
  fallbackMessage: string,
  variables: RunbookErrorVariables = {},
): never {
  throw new RunbookError(scope, code, fallbackMessage, variables);
}

export function getLocalizedRunbookErrorMessage(
  error: unknown,
  translate: RunbookErrorTranslate = t,
): string {
  if (!(error instanceof RunbookError)) return translate(classifyError(error).messageKey);
  const detail = translate(errorKeys[error.code], error.variables);
  return translate(
    error.scope === 'multiHost' ? 'runbook.multi.error.message' : 'runbook.error.message',
    { message: detail },
  );
}
