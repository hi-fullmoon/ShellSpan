import { isSafeReadOnlyCommand } from '@/lib/safe-shell-command';
import type { AgentCommandRiskAssessment } from '@/types/agent';

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|($`])(?:rm|rmdir|shred|wipefs|truncate)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])(?:mkfs(?:\.[\p{L}\p{N}_+-]+)?|fdisk|sfdisk|cfdisk|parted)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])dd(?:\s|$)/iu,
  /(?:^|[\s;&|($`])(?:shutdown|reboot|poweroff|halt)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])systemctl\s+(?:poweroff|reboot|halt|kexec|emergency|rescue)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])(?:iptables|ip6tables)\b[^\n;&|]*(?:\s-F(?:\s|$)|--flush(?:\s|$))/iu,
  /(?:^|[\s;&|($`])nft\s+(?:flush|delete)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])ufw\s+(?:reset|disable)(?:\s|$)/iu,
  /(?:^|[\s;&|($`])git\s+(?:reset\s+--hard|clean\s+[^\n;&|]*-[^\s]*f)/iu,
  /(?:^|[\s;&|($`])docker\s+(?:system|volume|image|container)\s+prune(?:\s|$)/iu,
  /(?:^|[\s;&|($`])kubectl\s+delete(?:\s|$)/iu,
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/iu,
];

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
