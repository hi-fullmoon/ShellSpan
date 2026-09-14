import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentSessionTarget } from '@/types/agent-session';

type LoginEndpoint = Pick<TerminalSession, 'host' | 'port' | 'username'>
  | AgentSessionTarget;

function isLocal(endpoint: LoginEndpoint): boolean {
  return ('kind' in endpoint && endpoint.kind === 'local')
    || (endpoint.host === 'local' && endpoint.port === 0);
}

function remoteIdentity(endpoint: LoginEndpoint): { username: string; host: string; port: number } | null {
  const username = endpoint.username?.trim();
  const rawHost = endpoint.host?.trim();
  const port = endpoint.port;
  if (!username || !rawHost || typeof port !== 'number'
    || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = rawHost.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return host ? { username, host, port } : null;
}

/** Login history survives terminal reconnects; tool target IDs remain session-specific. */
export function terminalLoginScopeKey(endpoint: LoginEndpoint): string | null {
  if (isLocal(endpoint)) return 'terminal-login:local';
  const identity = remoteIdentity(endpoint);
  return identity
    ? `terminal-login:${JSON.stringify([identity.username, identity.host, identity.port])}`
    : null;
}

export function terminalLoginLabel(endpoint: LoginEndpoint): string | null {
  if (isLocal(endpoint)) return endpoint.username ? `${endpoint.username}@local` : 'local';
  const identity = remoteIdentity(endpoint);
  if (!identity) return null;
  const host = identity.host.includes(':') ? `[${identity.host}]` : identity.host;
  return `${identity.username}@${host}:${identity.port}`;
}
