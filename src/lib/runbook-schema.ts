import type { JSONSchema } from 'monaco-editor/languages/features/json/register';

export const RUNBOOK_SCHEMA_URI = 'https://termbridge.local/schemas/runbook-v1.json';
export const RUNBOOK_MODEL_URI = 'inmemory://termbridge/runbook.runbook.json';

const nonEmptyString = (maxLength: number, description: string): JSONSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  description,
});

const idSchema: JSONSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
  patternErrorMessage: 'Use 1-64 lowercase letters, numbers, dots, underscores, or dashes.',
  description: 'Stable identifier used in reviews and execution evidence.',
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
      description: 'Required process exit code.',
    },
    stdoutContains: {
      type: 'array',
      maxItems: 20,
      description: 'Literal output fragments that must all be present.',
      items: nonEmptyString(1000, 'A literal fragment expected in standard output.'),
    },
  },
  defaultSnippets: [{
    label: 'Expected successful result',
    description: 'Require a successful exit code.',
    body: { exitCode: 0 },
  }],
};

const actionProperties: Record<string, JSONSchema> = {
  id: idSchema,
  description: nonEmptyString(4000, 'Human-readable purpose of this action.'),
  command: nonEmptyString(8192, 'Bounded shell command. Variables use {{UPPERCASE_NAME}} placeholders.'),
  expected: expectedSchema,
  timeoutSeconds: {
    type: 'integer',
    minimum: 1,
    maximum: 300,
    default: 30,
    description: 'Hard execution timeout in seconds.',
  },
};

const precheckSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'command', 'expected', 'timeoutSeconds'],
  properties: actionProperties,
  defaultSnippets: [{
    label: 'Read-only precheck',
    description: 'Add a bounded read-only verification action.',
    body: {
      id: '${1:check-id}',
      description: '${2:Describe the evidence this collects.}',
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
    'id',
    'description',
    'command',
    'risk',
    'impact',
    'expected',
    'timeoutSeconds',
    'safeToRetry',
  ],
  properties: {
    ...actionProperties,
    risk: {
      type: 'string',
      enum: ['readOnly', 'stateChange', 'destructive'],
      enumDescriptions: [
        'Collects evidence without changing remote state.',
        'Changes remote state and requires a rollback plan.',
        'May destroy data or availability and requires a second confirmation.',
      ],
      description: 'Declared risk. Runtime validation rejects understated risk.',
    },
    impact: nonEmptyString(4000, 'Exact scope and operational impact of this action.'),
    rollback: nonEmptyString(4000, 'Recovery plan. Required for stateChange and destructive actions.'),
    safeToRetry: {
      type: 'boolean',
      description: 'Whether a failed action can be deliberately retried.',
    },
  },
  allOf: [{
    if: {
      properties: {
        risk: { enum: ['stateChange', 'destructive'] },
      },
      required: ['risk'],
    },
    then: { required: ['rollback'] },
  }],
  defaultSnippets: [{
    label: 'Runbook step',
    description: 'Add a reviewed operational action.',
    body: {
      id: '${1:step-id}',
      description: '${2:Describe this action.}',
      command: '${3:sudo systemctl reload {{SERVICE}}}',
      risk: '${4:stateChange}',
      impact: '${5:Describe the affected service and users.}',
      rollback: '${6:Describe how to restore the previous state.}',
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
      patternErrorMessage: 'Use an uppercase shell-style identifier.',
      description: 'Name referenced by {{NAME}} placeholders.',
    },
    description: nonEmptyString(4000, 'What the operator should provide.'),
    required: {
      type: 'boolean',
      description: 'Whether execution must resolve a non-empty value.',
    },
    default: nonEmptyString(4000, 'Non-secret default value.'),
    keychainRef: {
      type: 'string',
      enum: [
        'keychain://profile/password',
        'keychain://profile/passphrase',
        'keychain://profile/jump-password',
        'keychain://profile/jump-passphrase',
      ],
      description: 'Supported OS-keychain reference for a secret variable.',
    },
  },
  not: { required: ['default', 'keychainRef'] },
  defaultSnippets: [{
    label: 'Runbook variable',
    description: 'Add a non-secret variable with a default value.',
    body: {
      name: '${1:VARIABLE}',
      description: '${2:Describe the operator input.}',
      required: true,
      default: '${3:value}',
    },
  }, {
    label: 'Keychain variable',
    description: 'Add a secret resolved only at the execution boundary.',
    body: {
      name: '${1:PASSWORD}',
      description: '${2:Profile password.}',
      required: true,
      keychainRef: 'keychain://profile/password',
    },
  }],
};

export const RUNBOOK_JSON_SCHEMA: JSONSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: RUNBOOK_SCHEMA_URI,
  title: 'TermBridge Runbook v1',
  description: 'A reviewable, locally stored workflow executed one approved action at a time.',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'name',
    'description',
    'evidenceMaxAgeSeconds',
    'variables',
    'prechecks',
    'steps',
  ],
  properties: {
    schemaVersion: {
      const: 1,
      description: 'Runbook format version. The current version is 1.',
    },
    id: idSchema,
    name: nonEmptyString(200, 'Display name shown during review.'),
    description: nonEmptyString(4000, 'Purpose and operating context of this Runbook.'),
    evidenceMaxAgeSeconds: {
      type: 'integer',
      minimum: 30,
      maximum: 3600,
      default: 300,
      description: 'How long successful precheck evidence remains valid.',
    },
    variables: {
      type: 'array',
      maxItems: 32,
      description: 'Operator inputs and keychain-backed secret references.',
      items: variableSchema,
    },
    prechecks: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      description: 'Bounded read-only checks that collect fresh evidence.',
      items: precheckSchema,
    },
    steps: {
      type: 'array',
      maxItems: 64,
      description: 'Reviewed operational actions. Evidence-only Runbooks may leave this empty.',
      items: stepSchema,
    },
  },
  defaultSnippets: [{
    label: 'TermBridge Runbook v1',
    description: 'Create a complete Runbook with one precheck and one reviewed step.',
    body: {
      schemaVersion: 1,
      id: '${1:runbook-id}',
      name: '${2:Runbook name}',
      description: '${3:Describe the operational objective.}',
      evidenceMaxAgeSeconds: 300,
      variables: [],
      prechecks: [{
        id: '${4:precheck-id}',
        description: '${5:Describe the evidence this collects.}',
        command: '${6:uname -a}',
        expected: { exitCode: 0 },
        timeoutSeconds: 15,
      }],
      steps: [],
    },
  }],
};

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
