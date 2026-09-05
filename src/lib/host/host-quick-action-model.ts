import { redactTerminalSecrets } from '@/lib/terminal/terminal-output-buffer';
import type {
  HostConnectionAction,
  HostQuickAction,
} from '@/types';

const MAX_QUICK_ACTIONS = 24;
const MAX_LABEL_LENGTH = 80;
const MAX_PATH_LENGTH = 1_024;
const MAX_COMMAND_LENGTH = 2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const QUICK_ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONNECTION_ACTIONS = new Set<HostConnectionAction>([
  'terminal',
  'sftp',
  'portForward',
  'overview',
]);

export type HostQuickActionValidationError =
  | 'invalidLabel'
  | 'invalidPath'
  | 'invalidCommand'
  | 'possibleSecret'
  | 'invalidAction';

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label
    && label.length <= MAX_LABEL_LENGTH
    && !CONTROL_CHARACTERS.test(label)
    ? label
    : undefined;
}

export function validateHostQuickAction(
  action: HostQuickAction,
): HostQuickActionValidationError | undefined {
  if (!cleanLabel(action.label)) return 'invalidLabel';
  if (action.kind === 'directory') {
    const path = action.path.trim();
    if (
      !path
      || path.length > MAX_PATH_LENGTH
      || CONTROL_CHARACTERS.test(path)
      || (action.target !== 'terminal' && action.target !== 'sftp')
    ) return 'invalidPath';
    return undefined;
  }
  if (action.kind === 'command') {
    if (
      !action.command.trim()
      || action.command.length > MAX_COMMAND_LENGTH
      || CONTROL_CHARACTERS.test(action.command)
    ) return 'invalidCommand';
    if (redactTerminalSecrets(action.command) !== action.command) return 'possibleSecret';
    return undefined;
  }
  return CONNECTION_ACTIONS.has(action.action) ? undefined : 'invalidAction';
}

export function sanitizeHostQuickActions(value: unknown): HostQuickAction[] {
  if (!Array.isArray(value)) return [];
  const actions: HostQuickAction[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (actions.length >= MAX_QUICK_ACTIONS || !item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = cleanLabel(candidate.label);
    if (!QUICK_ACTION_ID.test(id) || seen.has(id) || !label) continue;

    let action: HostQuickAction | undefined;
    if (candidate.kind === 'directory') {
      const allowed = new Set(['id', 'kind', 'label', 'path', 'target']);
      if (!Object.keys(candidate).every((key) => allowed.has(key))) continue;
      if (candidate.target !== 'terminal' && candidate.target !== 'sftp') continue;
      action = {
        id,
        kind: 'directory',
        label,
        path: typeof candidate.path === 'string' ? candidate.path.trim() : '',
        target: candidate.target,
      };
    } else if (candidate.kind === 'command') {
      const allowed = new Set(['id', 'kind', 'label', 'command']);
      if (!Object.keys(candidate).every((key) => allowed.has(key))) continue;
      action = {
        id,
        kind: 'command',
        label,
        command: typeof candidate.command === 'string' ? candidate.command : '',
      };
    } else if (candidate.kind === 'connection') {
      const allowed = new Set(['id', 'kind', 'label', 'action']);
      if (!Object.keys(candidate).every((key) => allowed.has(key))) continue;
      action = {
        id,
        kind: 'connection',
        label,
        action: candidate.action as HostConnectionAction,
      };
    }
    if (!action || validateHostQuickAction(action)) continue;
    seen.add(id);
    actions.push(action);
  }
  return actions;
}
