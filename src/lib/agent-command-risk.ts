import { isSafeReadOnlyCommand } from '@/lib/safe-shell-command';
import type { AgentCommandRiskAssessment } from '@/types/agent';

const EXECUTABLE_PREFIX = String.raw`(?:^|[\s;&|($\x60])(?:["']?(?:[^\s;&|($\x60"'<>]*[\\/])?)`;
const EXECUTABLE_SUFFIX = String.raw`(?:\.exe|\.com|\.cmd|\.bat)?["']?(?=\s|$)`;

function executablePattern(names: string): RegExp {
  return new RegExp(`${EXECUTABLE_PREFIX}(?:${names})${EXECUTABLE_SUFFIX}`, 'iu');
}

function executableArgumentsPattern(names: string, argumentsPattern: string): RegExp {
  return new RegExp(
    `${EXECUTABLE_PREFIX}(?:${names})${EXECUTABLE_SUFFIX}\\s+(?:${argumentsPattern})(?=\\s|$)`,
    'iu',
  );
}

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  executablePattern('rm|rmdir|shred|wipefs|truncate'),
  executablePattern('remove-item|clear-content|clear-disk|format-volume|initialize-disk|remove-partition'),
  executablePattern('del|erase|rd|format|diskpart'),
  executablePattern('mkfs(?:\\.[\\p{L}\\p{N}_+-]+)?|fdisk|sfdisk|cfdisk|parted'),
  executablePattern('dd'),
  executablePattern('shutdown|reboot|poweroff|halt'),
  executableArgumentsPattern('systemctl', 'poweroff|reboot|halt|kexec|emergency|rescue'),
  /(?:^|[\s;&|($`])(?:iptables|ip6tables)\b[^\n;&|]*(?:\s-F(?:\s|$)|--flush(?:\s|$))/iu,
  executableArgumentsPattern('nft', 'flush|delete'),
  executableArgumentsPattern('ufw', 'reset|disable'),
  executableArgumentsPattern('git', 'reset\\s+--hard|clean\\s+[^\\n;&|]*-[^\\s]*f'),
  executableArgumentsPattern('docker', '(?:system|volume|image|container)\\s+prune'),
  executableArgumentsPattern('kubectl', 'delete'),
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/iu,
];

// These commands are observational from an integrity perspective, but can
// disclose arbitrary file contents, process arguments, logs, container
// environment variables, or cluster secrets. They therefore stay in the
// read-only risk class while still requiring an explicit user decision in the
// "auto approve read-only" mode.
const APPROVAL_REQUIRED_READ_PROGRAMS = new Set([
  'cat',
  'docker',
  'du',
  'grep',
  'head',
  'journalctl',
  'kubectl',
  'ls',
  'lsof',
  'netstat',
  'ps',
  'ss',
  'stat',
  'systemctl',
  'tail',
]);

function containsDestructivePattern(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Splits shell lists and pipelines without interpreting quoted separators.
 * Anything more complex stays outside the read-only allowlist and therefore
 * fails closed as a state change.
 */
function splitSimpleCompoundCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = (): boolean => {
    const value = current.trim();
    current = '';
    if (!value) return false;
    parts.push(value);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '`' || character === '$' || character === '(' || character === ')') {
      return null;
    }
    if (character === '>' || character === '<' || character === '\n' || character === '\r') {
      return null;
    }
    if (character === ';' || character === '|') {
      if (!push()) return null;
      if (command[index + 1] === character) index += 1;
      continue;
    }
    if (character === '&') {
      if (command[index + 1] !== '&' || !push()) return null;
      index += 1;
      continue;
    }
    current += character;
  }

  if (quote || escaped || !push()) return null;
  return parts;
}

/**
 * Local command risk classification. Destructive signatures are evaluated
 * first over the entire command so a harmless prefix cannot downgrade a
 * destructive suffix. Only commands accepted by the existing read-only
 * parser (individually or as every segment of a simple compound command) are
 * read-only; everything else is a state change.
 */
export function classifyAgentCommandRisk(command: string): AgentCommandRiskAssessment {
  if (containsDestructivePattern(command)) {
    return { risk: 'destructive', reason: 'destructivePattern' };
  }
  if (isSafeReadOnlyCommand(command)) {
    return { risk: 'readOnly', reason: 'readOnlyAllowlist' };
  }
  const parts = splitSimpleCompoundCommand(command);
  if (parts && parts.length > 1 && parts.every(isSafeReadOnlyCommand)) {
    return { risk: 'readOnly', reason: 'compoundReadOnlyAllowlist' };
  }
  return { risk: 'stateChange', reason: 'unrecognizedStateChange' };
}

function segmentProgram(segment: string): string | undefined {
  const first = segment.trim().split(/\s+/, 1)[0];
  if (!first) return undefined;
  return first.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/i, '');
}

/**
 * Read-only does not imply confidentiality-safe. Keep content-bearing or
 * identity-rich diagnostics behind an explicit approval even when the user
 * selected automatic approval for ordinary health checks.
 */
export function requiresApprovalForReadOnlyCommand(command: string): boolean {
  if (classifyAgentCommandRisk(command).risk !== 'readOnly') return false;
  const segments = splitSimpleCompoundCommand(command);
  if (!segments) return true;
  return segments.some((segment) => {
    const program = segmentProgram(segment);
    return !program || APPROVAL_REQUIRED_READ_PROGRAMS.has(program);
  });
}
