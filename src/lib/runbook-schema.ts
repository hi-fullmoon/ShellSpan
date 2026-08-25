import type { JSONSchema } from 'monaco-editor/languages/features/json/register';
import type { LocaleKey } from '@/locales';

export const RUNBOOK_SCHEMA_URI = 'https://termbridge.local/schemas/runbook-v1.json';
export const RUNBOOK_MODEL_URI = 'inmemory://termbridge/runbook.runbook.json';

export type RunbookSchemaTranslate = (
  key: LocaleKey,
  variables?: Record<string, string | number>,
) => string;

export function createRunbookJsonSchema(t: RunbookSchemaTranslate): JSONSchema {
  const nonEmptyString = (maxLength: number, description: string): JSONSchema => ({
    type: 'string',
    minLength: 1,
    maxLength,
    description,
  });

  const idSchema: JSONSchema = {
    type: 'string',
    pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
    patternErrorMessage: t('runbook.schema.idFormat'),
    description: t('runbook.schema.idDescription'),
  };

  const expectedSchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['exitCode'],
    properties: {
      exitCode: {
        type: 'integer',
        minimum: 0,
        maximum: 255,
        description: t('runbook.schema.exitCode'),
      },
      stdoutContains: {
        type: 'array',
        maxItems: 20,
        description: t('runbook.schema.stdoutContains'),
        items: nonEmptyString(1000, t('runbook.schema.stdoutFragment')),
      },
    },
    defaultSnippets: [{
      label: t('runbook.schema.expectedSnippetLabel'),
      description: t('runbook.schema.expectedSnippetDescription'),
      body: { exitCode: 0 },
    }],
  };

  const actionProperties: Record<string, JSONSchema> = {
    id: idSchema,
    description: nonEmptyString(4000, t('runbook.schema.actionDescription')),
    command: nonEmptyString(8192, t('runbook.schema.command')),
    expected: expectedSchema,
    timeoutSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      default: 30,
      description: t('runbook.schema.timeout'),
    },
  };

  const precheckSchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'description', 'command', 'expected', 'timeoutSeconds'],
    properties: actionProperties,
    defaultSnippets: [{
      label: t('runbook.schema.precheckSnippetLabel'),
      description: t('runbook.schema.precheckSnippetDescription'),
      body: {
        id: '${1:check-id}',
        description: `\${2:${t('runbook.schema.precheckSnippetBodyDescription')}}`,
        command: '${3:systemctl status {{SERVICE}}}',
        expected: { exitCode: 0 },
        timeoutSeconds: 15,
      },
    }],
  };

  const stepSchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'description', 'command', 'risk', 'impact', 'expected', 'timeoutSeconds', 'safeToRetry',
    ],
    properties: {
      ...actionProperties,
      risk: {
        type: 'string',
        enum: ['readOnly', 'stateChange', 'destructive'],
        enumDescriptions: [
          t('runbook.schema.riskReadOnly'),
          t('runbook.schema.riskStateChange'),
          t('runbook.schema.riskDestructive'),
        ],
        description: t('runbook.schema.risk'),
      },
      impact: nonEmptyString(4000, t('runbook.schema.impact')),
      rollback: nonEmptyString(4000, t('runbook.schema.rollback')),
      safeToRetry: {
        type: 'boolean',
        description: t('runbook.schema.safeToRetry'),
      },
    },
    allOf: [{
      if: {
        properties: { risk: { enum: ['stateChange', 'destructive'] } },
        required: ['risk'],
      },
      then: { required: ['rollback'] },
    }],
    defaultSnippets: [{
      label: t('runbook.schema.stepSnippetLabel'),
      description: t('runbook.schema.stepSnippetDescription'),
      body: {
        id: '${1:step-id}',
        description: `\${2:${t('runbook.schema.stepSnippetBodyDescription')}}`,
        command: '${3:sudo systemctl reload {{SERVICE}}}',
        risk: '${4:stateChange}',
        impact: `\${5:${t('runbook.schema.stepSnippetBodyImpact')}}`,
        rollback: `\${6:${t('runbook.schema.stepSnippetBodyRollback')}}`,
        expected: { exitCode: 0 },
        timeoutSeconds: 30,
        safeToRetry: true,
      },
    }],
  };

  const variableSchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'description', 'required'],
    properties: {
      name: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{0,63}$',
        patternErrorMessage: t('runbook.schema.variableNameFormat'),
        description: t('runbook.schema.variableName'),
      },
      description: nonEmptyString(4000, t('runbook.schema.variableDescription')),
      required: { type: 'boolean', description: t('runbook.schema.variableRequired') },
      default: nonEmptyString(4000, t('runbook.schema.variableDefault')),
      keychainRef: {
        type: 'string',
        enum: [
          'keychain://profile/password',
          'keychain://profile/passphrase',
          'keychain://profile/jump-password',
          'keychain://profile/jump-passphrase',
        ],
        description: t('runbook.schema.keychainRef'),
      },
    },
    not: { required: ['default', 'keychainRef'] },
    defaultSnippets: [{
      label: t('runbook.schema.variableSnippetLabel'),
      description: t('runbook.schema.variableSnippetDescription'),
      body: {
        name: '${1:VARIABLE}',
        description: `\${2:${t('runbook.schema.variableSnippetBodyDescription')}}`,
        required: true,
        default: '${3:value}',
      },
    }, {
      label: t('runbook.schema.keychainSnippetLabel'),
      description: t('runbook.schema.keychainSnippetDescription'),
      body: {
        name: '${1:PASSWORD}',
        description: `\${2:${t('runbook.schema.keychainSnippetBodyDescription')}}`,
        required: true,
        keychainRef: 'keychain://profile/password',
      },
    }],
  };

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: RUNBOOK_SCHEMA_URI,
    title: 'TermBridge Runbook v1',
    description: t('runbook.schema.documentDescription'),
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'id', 'name', 'description', 'evidenceMaxAgeSeconds', 'variables', 'prechecks', 'steps',
    ],
    properties: {
      schemaVersion: { const: 1, description: t('runbook.schema.schemaVersion') },
      id: idSchema,
      name: nonEmptyString(200, t('runbook.schema.name')),
      description: nonEmptyString(4000, t('runbook.schema.description')),
      evidenceMaxAgeSeconds: {
        type: 'integer',
        minimum: 30,
        maximum: 3600,
        default: 300,
        description: t('runbook.schema.evidenceMaxAge'),
      },
      variables: {
        type: 'array',
        maxItems: 32,
        description: t('runbook.schema.variables'),
        items: variableSchema,
      },
      prechecks: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        description: t('runbook.schema.prechecks'),
        items: precheckSchema,
      },
      steps: {
        type: 'array',
        maxItems: 64,
        description: t('runbook.schema.steps'),
        items: stepSchema,
      },
    },
    defaultSnippets: [{
      label: 'TermBridge Runbook v1',
      description: t('runbook.schema.documentSnippetDescription'),
      body: {
        schemaVersion: 1,
        id: '${1:runbook-id}',
        name: `\${2:${t('runbook.schema.documentSnippetBodyName')}}`,
        description: `\${3:${t('runbook.schema.documentSnippetBodyDescription')}}`,
        evidenceMaxAgeSeconds: 300,
        variables: [],
        prechecks: [{
          id: '${4:precheck-id}',
          description: `\${5:${t('runbook.schema.precheckSnippetBodyDescription')}}`,
          command: '${6:uname -a}',
          expected: { exitCode: 0 },
          timeoutSeconds: 15,
        }],
        steps: [],
      },
    }],
  };
}

export function runbookVariableNames(sourceText: string): string[] {
  try {
    const value = JSON.parse(sourceText) as { variables?: unknown };
    if (!Array.isArray(value.variables)) return [];
    return [...new Set(value.variables.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const name = (entry as { name?: unknown }).name;
      return typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) ? [name] : [];
    }))];
  } catch {
    return [];
  }
}
