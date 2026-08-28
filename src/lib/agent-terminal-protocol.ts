import terminalActionSchemaV1 from '../../protocol/agent-terminal/v1/terminal-actions.schema.json';

export const TERMINAL_PROTOCOL_SCHEMA_VERSION_V1 = 1 as const;
export const MAX_TERMINAL_ACTION_BYTES_V1 = 16 * 1024;
export const TERMINAL_ACTION_SCHEMA_V1: Readonly<Record<string, unknown>> = terminalActionSchemaV1;

export type TerminalDriverIdV1 = 'fixture.shellPrompt';
export type TerminalProgramIdV1 = 'termbridge-interactive-fixture';
export type TerminalFixtureScenarioV1 = 'confirm' | 'choice';
export type TerminalResponseV1 = 'accept' | 'decline' | 'retry' | 'cancel';
export type TerminalKeyV1 =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'ctrlC'
  | 'ctrlD'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight';
export type TerminalHandoffReasonV1 =
  | 'userRequested'
  | 'sensitivePrompt'
  | 'unsupportedInteraction'
  | 'unknownPrompt';

export interface TerminalStartActionV1 {
  schemaVersion: 1;
  action: 'terminal.start';
  actionId: string;
  driver: TerminalDriverIdV1;
  program: TerminalProgramIdV1;
  arguments: { scenario: TerminalFixtureScenarioV1 };
}

export interface TerminalRespondActionV1 {
  schemaVersion: 1;
  action: 'terminal.respond';
  actionId: string;
  observationId: string;
  response: TerminalResponseV1;
}

export interface TerminalKeyActionV1 {
  schemaVersion: 1;
  action: 'terminal.key';
  actionId: string;
  observationId: string;
  key: TerminalKeyV1;
}

export interface TerminalHandoffActionV1 {
  schemaVersion: 1;
  action: 'terminal.handoff';
  actionId: string;
  observationId: string;
  reason: TerminalHandoffReasonV1;
}

export type TerminalActionV1 =
  | TerminalStartActionV1
  | TerminalRespondActionV1
  | TerminalKeyActionV1
  | TerminalHandoffActionV1;

export type TerminalProtocolDecodeErrorKindV1 = 'tooLarge' | 'invalidJson' | 'invalidContract';

export class TerminalProtocolDecodeErrorV1 extends Error {
  constructor(
    readonly kind: TerminalProtocolDecodeErrorKindV1,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'TerminalProtocolDecodeErrorV1';
  }
}

function fail(message: string, field?: string): never {
  throw new TerminalProtocolDecodeErrorV1('invalidContract', message, field);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${field} contains unknown field ${unknown}`, field);
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(`${field} is not in the closed enum`, field);
  }
  return value as T;
}

function identifierValue(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  ) {
    return fail(`${field} is not a valid protocol identifier`, field);
  }
  return value;
}

function parseAction(raw: string | unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > MAX_TERMINAL_ACTION_BYTES_V1) {
      throw new TerminalProtocolDecodeErrorV1('tooLarge', 'terminal action exceeds 16 KiB');
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new TerminalProtocolDecodeErrorV1(
        'invalidJson',
        'terminal action is not a single JSON document',
      );
    }
  }
  return objectValue(value, 'terminal action');
}

export function decodeTerminalActionV1(raw: string | unknown): TerminalActionV1 {
  const value = parseAction(raw);
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1', 'schemaVersion');
  const action = enumValue(
    value.action,
    ['terminal.start', 'terminal.respond', 'terminal.key', 'terminal.handoff'] as const,
    'action',
  );
  const actionId = identifierValue(value.actionId, 'actionId');

  if (action === 'terminal.start') {
    exactKeys(
      value,
      ['schemaVersion', 'action', 'actionId', 'driver', 'program', 'arguments'],
      'terminal.start',
    );
    const args = objectValue(value.arguments, 'arguments');
    exactKeys(args, ['scenario'], 'arguments');
    return {
      schemaVersion: 1,
      action,
      actionId,
      driver: enumValue(value.driver, ['fixture.shellPrompt'] as const, 'driver'),
      program: enumValue(
        value.program,
        ['termbridge-interactive-fixture'] as const,
        'program',
      ),
      arguments: {
        scenario: enumValue(args.scenario, ['confirm', 'choice'] as const, 'arguments.scenario'),
      },
    };
  }

  const observationId = identifierValue(value.observationId, 'observationId');
  if (action === 'terminal.respond') {
    exactKeys(
      value,
      ['schemaVersion', 'action', 'actionId', 'observationId', 'response'],
      'terminal.respond',
    );
    return {
      schemaVersion: 1,
      action,
      actionId,
      observationId,
      response: enumValue(
        value.response,
        ['accept', 'decline', 'retry', 'cancel'] as const,
        'response',
      ),
    };
  }
  if (action === 'terminal.key') {
    exactKeys(
      value,
      ['schemaVersion', 'action', 'actionId', 'observationId', 'key'],
      'terminal.key',
    );
    return {
      schemaVersion: 1,
      action,
      actionId,
      observationId,
      key: enumValue(
        value.key,
        [
          'enter', 'escape', 'tab', 'ctrlC', 'ctrlD',
          'arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight',
        ] as const,
        'key',
      ),
    };
  }

  exactKeys(
    value,
    ['schemaVersion', 'action', 'actionId', 'observationId', 'reason'],
    'terminal.handoff',
  );
  return {
    schemaVersion: 1,
    action,
    actionId,
    observationId,
    reason: enumValue(
      value.reason,
      ['userRequested', 'sensitivePrompt', 'unsupportedInteraction', 'unknownPrompt'] as const,
      'reason',
    ),
  };
}
