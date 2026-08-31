import type {
  AuthMethod,
  ConnectionProfile,
  HostQuickAction,
  JumpHostConfig,
  PortForwardRule,
} from '@/types';
import { redactTerminalSecrets } from '@/lib/terminal-output-buffer';
import { sanitizeHostQuickActions } from '@/lib/host-quick-action-model';

export interface ConnectionImportCandidate {
  id: string;
  source: 'openssh' | 'shellspan';
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  identityFile?: string;
  jumpHost?: Omit<JumpHostConfig, 'password' | 'keychainKeyId' | 'privateKeyData' | 'passphrase'>;
  group?: string;
  tags?: string[];
  favorite?: boolean;
  notes?: string;
  portForwards?: PortForwardRule[];
  quickActions?: HostQuickAction[];
  warnings: string[];
}

export interface ConnectionImportPreview extends ConnectionImportCandidate {
  conflict: boolean;
}

interface ConnectionImportDependencies {
  readTextFile: (path: string) => Promise<string>;
  addKey: (key: {
    label: string;
    kind: 'keyFile';
    privateKey: string;
  }) => Promise<{ id: string }>;
  removeKey: (id: string) => Promise<unknown>;
  addProfile: (
    profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<{ id: string }>;
  removeProfile: (id: string) => Promise<unknown>;
  onRollbackError?: (resource: 'profile' | 'key', id: string, error: unknown) => void;
}

export interface ConnectionImportResult {
  profileIds: string[];
  keyIds: string[];
}

interface SshBlock {
  aliases: string[];
  options: Map<string, string>;
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else if (char === '#') {
      break;
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parsePort(value: string | undefined, fallback = 22): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function parseProxyJump(value: string | undefined): ConnectionImportCandidate['jumpHost'] {
  if (!value || value.toLowerCase() === 'none' || value.includes(',')) return undefined;
  let target = value;
  let username = '';
  const at = target.lastIndexOf('@');
  if (at >= 0) {
    username = target.slice(0, at);
    target = target.slice(at + 1);
  }
  let host = target;
  let port = 22;
  const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(target);
  if (bracketed) {
    host = bracketed[1];
    port = parsePort(bracketed[2]);
  } else {
    const colon = target.lastIndexOf(':');
    if (colon > 0 && target.indexOf(':') === colon) {
      host = target.slice(0, colon);
      port = parsePort(target.slice(colon + 1));
    }
  }
  if (!host || !username) return undefined;
  return { host, port, username, authMethod: 'password' };
}

export function parseOpenSshConfig(content: string): ConnectionImportCandidate[] {
  const globals = new Map<string, string>();
  const blocks: SshBlock[] = [];
  let current: SshBlock | undefined;

  for (const rawLine of content.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const tokens = tokenize(rawLine.trim());
    if (tokens.length < 2) continue;
    const key = tokens[0].toLowerCase();
    const value = tokens.slice(1).join(' ');
    if (key === 'host') {
      current = { aliases: tokens.slice(1), options: new Map(globals) };
      blocks.push(current);
      continue;
    }
    const target = current?.options ?? globals;
    // OpenSSH uses the first obtained value for these scalar options.
    if (!target.has(key)) target.set(key, value);
  }

  const candidates: ConnectionImportCandidate[] = [];
  for (const block of blocks) {
    const usableAliases = block.aliases.filter(
      (alias) => !alias.startsWith('!') && !/[?*]/.test(alias),
    );
    for (const alias of usableAliases) {
      const host = block.options.get('hostname') ?? alias;
      const username = block.options.get('user') ?? '';
      if (!host || !username) continue;
      const identityFile = block.options.get('identityfile');
      const proxyJumpValue = block.options.get('proxyjump');
      const jumpHost = parseProxyJump(proxyJumpValue);
      const warnings: string[] = [];
      if (proxyJumpValue && !jumpHost && proxyJumpValue.toLowerCase() !== 'none') {
        warnings.push('unsupported-proxy-jump');
      }
      candidates.push({
        id: `openssh:${alias}`,
        source: 'openssh',
        name: alias,
        host,
        port: parsePort(block.options.get('port')),
        username,
        authMethod: identityFile ? 'key' : 'password',
        identityFile,
        jumpHost,
        warnings,
      });
    }
  }
  return candidates;
}

interface ExportedProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  jumpHost?: ConnectionImportCandidate['jumpHost'];
  group?: string;
  tags?: string[];
  favorite?: boolean;
  notes?: string;
  portForwards?: PortForwardRule[];
  quickActions?: HostQuickAction[];
}

function cleanOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanTags(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim()).filter(Boolean))]
    : [];
}

function sanitizeExportedJumpHost(value: unknown): ConnectionImportCandidate['jumpHost'] {
  if (!value || typeof value !== 'object') return undefined;
  const jump = value as Record<string, unknown>;
  const allowed = new Set(['host', 'port', 'username', 'authMethod']);
  if (!Object.keys(jump).every((key) => allowed.has(key))) return undefined;
  if (
    typeof jump.host !== 'string'
    || typeof jump.username !== 'string'
    || !jump.host.trim()
    || !jump.username.trim()
    || (jump.authMethod !== 'password' && jump.authMethod !== 'key')
  ) return undefined;
  return {
    host: jump.host,
    port: parsePort(String(jump.port ?? 22)),
    username: jump.username,
    authMethod: jump.authMethod,
  };
}

function sanitizePortForwardRules(value: unknown): PortForwardRule[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set([
    'id',
    'name',
    'kind',
    'localPort',
    'remoteHost',
    'remotePort',
    'autoStart',
  ]);
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const rule = item as Record<string, unknown>;
    if (!Object.keys(rule).every((key) => allowed.has(key))) return [];
    const id = cleanOptionalText(rule.id);
    const name = cleanOptionalText(rule.name);
    const remoteHost = cleanOptionalText(rule.remoteHost);
    const localPort = Number(rule.localPort);
    const remotePort = Number(rule.remotePort);
    if (
      !id
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
      || seen.has(id)
      || !name
      || name.length > 100
      || /[\u0000-\u001f\u007f]/.test(name)
      || !remoteHost
      || (rule.kind !== 'local' && rule.kind !== 'remote')
      || !Number.isInteger(localPort)
      || localPort < 1
      || localPort > 65_535
      || !Number.isInteger(remotePort)
      || remotePort < 1
      || remotePort > 65_535
      || (rule.kind === 'remote' && !['127.0.0.1', 'localhost', '::1'].includes(remoteHost))
    ) return [];
    seen.add(id);
    return [{
      id,
      name,
      kind: rule.kind,
      localPort,
      remoteHost,
      remotePort,
      autoStart: rule.autoStart === true,
    }];
  });
}

export interface ConnectionExportFile {
  schemaVersion: 1 | 2 | 3;
  exportedAt: string;
  profiles: ExportedProfile[];
}

export function exportConnections(
  profiles: ConnectionProfile[],
  exportedAt = new Date().toISOString(),
): string {
  const payload: ConnectionExportFile = {
    schemaVersion: 3,
    exportedAt,
    profiles: profiles.map((profile) => ({
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      jumpHost: profile.jumpHost
        ? {
            host: profile.jumpHost.host,
            port: profile.jumpHost.port,
            username: profile.jumpHost.username,
            authMethod: profile.jumpHost.authMethod,
          }
        : undefined,
      group: profile.group ? redactTerminalSecrets(profile.group) : undefined,
      tags: (profile.tags ?? []).map((tag) => redactTerminalSecrets(tag)),
      favorite: Boolean(profile.favorite),
      notes: profile.notes ? redactTerminalSecrets(profile.notes) : undefined,
      portForwards: sanitizePortForwardRules(profile.portForwards),
      quickActions: sanitizeHostQuickActions(profile.quickActions),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function parseConnectionExport(content: string): ConnectionImportCandidate[] {
  try {
    const parsed = JSON.parse(content) as Partial<ConnectionExportFile>;
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)
      || !Array.isArray(parsed.profiles)
    ) return [];
    return parsed.profiles.flatMap((profile, index) => {
      if (!profile || typeof profile !== 'object') return [];
      const candidate = profile as Partial<ExportedProfile>;
      if (
        typeof candidate.name !== 'string'
        || typeof candidate.host !== 'string'
        || typeof candidate.username !== 'string'
        || !candidate.name.trim()
        || !candidate.host.trim()
        || !candidate.username.trim()
        || (candidate.authMethod !== 'password' && candidate.authMethod !== 'key')
      ) return [];
      return [{
        id: `shellspan:${index}:${candidate.name}`,
        source: 'shellspan' as const,
        name: candidate.name,
        host: candidate.host,
        port: parsePort(String(candidate.port ?? 22)),
        username: candidate.username,
        // Key material and device-local references are deliberately absent;
        // imported key profiles must be rebound by the user.
        authMethod: candidate.authMethod,
        jumpHost: sanitizeExportedJumpHost(candidate.jumpHost),
        group: cleanOptionalText(candidate.group),
        tags: cleanTags(candidate.tags),
        favorite: candidate.favorite === true,
        notes: cleanOptionalText(candidate.notes),
        portForwards: sanitizePortForwardRules(candidate.portForwards),
        quickActions: sanitizeHostQuickActions(candidate.quickActions),
        warnings: candidate.authMethod === 'key' ? ['key-rebind-required'] : [],
      }];
    });
  } catch {
    return [];
  }
}

export function parseConnectionImport(content: string): ConnectionImportCandidate[] {
  const trimmed = content.trimStart();
  return trimmed.startsWith('{')
    ? parseConnectionExport(content)
    : parseOpenSshConfig(content);
}

export function buildConnectionImportPreview(
  candidates: ConnectionImportCandidate[],
  existing: ConnectionProfile[],
): ConnectionImportPreview[] {
  return candidates.map((candidate) => ({
    ...candidate,
    conflict: existing.some((profile) => (
      profile.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase()
      || (
        profile.host.toLocaleLowerCase() === candidate.host.toLocaleLowerCase()
        && profile.port === candidate.port
        && profile.username.toLocaleLowerCase() === candidate.username.toLocaleLowerCase()
      )
    )),
  }));
}

/**
 * Imports a selected batch as one logical transaction. The backing stores use
 * separate OS/database APIs, so a failure is compensated by deleting every
 * profile and key created by this batch in reverse order.
 */
export async function importConnectionsTransactionally(
  candidates: ConnectionImportCandidate[],
  dependencies: ConnectionImportDependencies,
): Promise<ConnectionImportResult> {
  const profileIds: string[] = [];
  const keyIds: string[] = [];
  const keyByPath = new Map<string, string>();
  try {
    for (const candidate of candidates) {
      let keychainKeyId: string | undefined;
      if (candidate.identityFile) {
        keychainKeyId = keyByPath.get(candidate.identityFile);
        if (!keychainKeyId) {
          const privateKey = await dependencies.readTextFile(candidate.identityFile);
          const key = await dependencies.addKey({
            label: candidate.identityFile.split(/[\\/]/).pop() ?? candidate.name,
            kind: 'keyFile',
            privateKey,
          });
          keychainKeyId = key.id;
          keyByPath.set(candidate.identityFile, key.id);
          keyIds.push(key.id);
        }
      }
      const profile = await dependencies.addProfile({
        name: candidate.name,
        host: candidate.host,
        port: candidate.port,
        username: candidate.username,
        authMethod: candidate.authMethod,
        keychainKeyId,
        jumpHost: candidate.jumpHost,
        group: candidate.group,
        tags: candidate.tags,
        favorite: candidate.favorite,
        notes: candidate.notes,
        portForwards: candidate.portForwards,
        quickActions: candidate.quickActions,
      });
      profileIds.push(profile.id);
    }
    return { profileIds, keyIds };
  } catch (error) {
    for (const profileId of [...profileIds].reverse()) {
      try {
        await dependencies.removeProfile(profileId);
      } catch (rollbackError) {
        dependencies.onRollbackError?.('profile', profileId, rollbackError);
      }
    }
    for (const keyId of [...keyIds].reverse()) {
      try {
        await dependencies.removeKey(keyId);
      } catch (rollbackError) {
        dependencies.onRollbackError?.('key', keyId, rollbackError);
      }
    }
    throw error;
  }
}
