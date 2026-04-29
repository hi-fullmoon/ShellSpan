import type { ConnectionProfile } from '../types';

export function parseQuickConnect(input: string): { username?: string; host: string; port?: number } | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^(?:(?<user>[^@:\s]+)@)?(?<host>[^@:\s]+)(?::(?<port>\d+))?$/);
  if (!match?.groups?.host) {
    return undefined;
  }

  const host = match.groups.host.trim();
  if (!host) {
    return undefined;
  }

  const port = match.groups.port ? Number(match.groups.port) : undefined;
  if (port !== undefined && (Number.isNaN(port) || port < 1 || port > 65535)) {
    return undefined;
  }

  return {
    username: match.groups.user?.trim() || undefined,
    host,
    port,
  };
}

export function createEmptyProfile(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "New Session",
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    pinned: false,
    favorite: false,
    rememberPassword: false,
    password: "",
    privateKeyPath: "",
    passphrase: "",
  };
}

export function sanitizeProfileForStorage(
  profile: ConnectionProfile,
): ConnectionProfile {
  return {
    ...profile,
    pinned: profile.pinned ?? false,
    favorite: profile.favorite ?? false,
    password: "", // always clear — passwords are stored in OS keychain
    passphrase: "",
    jumpHost: profile.jumpHost
      ? {
          ...profile.jumpHost,
          password: "",
          passphrase: "",
        }
      : undefined,
  };
}

export function describeSession(profile: ConnectionProfile) {
  return profile.name.trim() || `${profile.username}@${profile.host}`;
}
