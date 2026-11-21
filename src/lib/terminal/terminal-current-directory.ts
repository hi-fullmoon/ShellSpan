import { terminalRegistry, type TerminalOutputFilter } from '@/components/terminal/registry/terminal-registry';
import { invokeGetTerminalBrokerSnapshot, invokeRevealPath } from '@/lib/ipc/tauri';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { SftpLocationRequest } from '@/stores/sftpStore';
import { useProfileStore } from '@/stores/profileStore';
import { openHostPath } from '@/lib/host/host-quick-actions';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { agentTerminalLeaseState } from '@/components/terminal/agent-terminal-lease-state';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';

const QUERY_TIMEOUT_MS = 4_000;
const QUERY_BUFFER_LIMIT = 16 * 1024;
const OSC = '\u001b]777;shellspan-cwd:';
const BEL = '\u0007';

function decodeDirectory(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const directory = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return directory && !/[\u0000-\u001f\u007f]/.test(directory) ? directory : null;
  } catch {
    return null;
  }
}

export function isAbsoluteTerminalPath(session: Pick<TerminalSession, 'host' | 'port'>, directory: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(directory)) return false;
  const local = session.host === 'local' && session.port === 0;
  return local
    ? /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(directory)
    : directory.startsWith('/');
}

function queryCommand(token: string): { command: string; terminator: string } {
  return {
    command: `python3 -c 'import os,base64,sys;sys.stdout.write("\\x1b]777;shellspan-cwd:${token}:"+base64.b64encode(os.getcwd().encode()).decode()+"\\x07")'`,
    terminator: '\n',
  };
}

/**
 * Reads the directory reported by shell integration. Remote shells without
 * integration can answer through a private OSC probe. A partial user command
 * is never disturbed.
 */
export async function readTerminalCurrentDirectory(
  session: TerminalSession,
  mayProbe: () => boolean = () => true,
): Promise<string | null> {
  const controller = terminalRegistry.get(session.sessionId);
  if (!controller || controller.hasPendingUserInput() || controller.hasUnverifiedUserSubmission()) return null;
  await controller.whenOutputReady();
  if (controller.hasPendingUserInput() || controller.hasUnverifiedUserSubmission()) return null;

  const local = session.host === 'local' && session.port === 0;
  try {
    const integrated = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
    const directory = integrated?.currentDirectory;
    if (integrated?.promptReady && directory && isAbsoluteTerminalPath(session, directory)) {
      return directory;
    }
    if (integrated?.integrationState === 'ready') return null;
  } catch {
    // Older or unintegrated remote sessions can still use the interactive probe.
  }
  const liveSession = useTerminalStore.getState().sessions.find((item) => item.sessionId === session.sessionId);
  const effectiveSession = liveSession ?? session;
  // PowerShell echoes the injected command before its response can be filtered.
  // Never write a background directory probe into a local interactive terminal.
  if (
    local
    || !mayProbe()
    || controller.hasPendingUserInput()
    || controller.hasUnverifiedUserSubmission()
    || terminalRegistry.get(session.sessionId) !== controller
    || effectiveSession.status !== 'connected'
    || effectiveSession.readOnly === true
    || effectiveSession.foregroundHandoffActive === true
    || effectiveSession.credentialPromptActive === true
    || terminalInputReadiness.isPreparing(session.sessionId)
    || Boolean(agentTerminalLeaseState.get(session.sessionId))
    || (controller.terminal?.buffer.active.type !== undefined && controller.terminal.buffer.active.type !== 'normal')
    || Boolean(controller.hasKnownCredentialPrompt?.())
  ) return null;

  const token = crypto.randomUUID().replace(/-/g, '');
  const prefix = `${OSC}${token}:`;
  let buffer = '';
  let settled = false;
  let matched = false;
  let matchedDirectory: string | null = null;
  let quietTimeout: number | null = null;
  let finish!: (value: string | null) => void;
  const result = new Promise<string | null>((resolve) => { finish = resolve; });
  const settle = (value: string | null): void => {
    if (settled) return;
    settled = true;
    finish(value);
  };
  const settleAfterPrompt = (value: string | null): void => {
    if (quietTimeout !== null) window.clearTimeout(quietTimeout);
    quietTimeout = window.setTimeout(() => settle(value), 30);
  };
  const filter: TerminalOutputFilter = {
    push(chunk) {
      if (settled) return chunk;
      if (matched) {
        settleAfterPrompt(matchedDirectory);
        return '';
      }
      buffer += chunk;
      const start = buffer.indexOf(prefix);
      if (start < 0) {
        if (buffer.length > QUERY_BUFFER_LIMIT) settle(null);
        return '';
      }
      const payloadStart = start + prefix.length;
      const end = buffer.indexOf(BEL, payloadStart);
      if (end < 0) return '';
      const directory = decodeDirectory(buffer.slice(payloadStart, end));
      matched = true;
      matchedDirectory = directory && isAbsoluteTerminalPath(session, directory) ? directory : null;
      buffer = '';
      settleAfterPrompt(matchedDirectory);
      return '';
    },
    finish() {
      const remainder = matched ? '' : buffer;
      buffer = '';
      return remainder;
    },
  };

  const releaseInput = controller.suppressUserInput();
  const removeFilter = controller.subscribeOutputFilter(filter);
  const timeout = window.setTimeout(() => settle(null), QUERY_TIMEOUT_MS);
  try {
    const { command, terminator } = queryCommand(token);
    await controller.writeInput(`${command}${terminator}`);
    return await result;
  } catch {
    settle(null);
    return null;
  } finally {
    window.clearTimeout(timeout);
    if (quietTimeout !== null) window.clearTimeout(quietTimeout);
    removeFilter();
    releaseInput();
  }
}

export async function getTerminalMenuDirectory(sessionId: string, allowProbe = true): Promise<string | null> {
  const getSession = () => useTerminalStore.getState().sessions.find((item) => item.sessionId === sessionId);
  const session = getSession();
  if (session?.status !== 'connected') return null;
  if (session.currentDirectory && isAbsoluteTerminalPath(session, session.currentDirectory)) return session.currentDirectory;
  const mayProbe = () => {
    const current = getSession();
    const controller = terminalRegistry.get(sessionId);
    return allowProbe && current?.status === 'connected' && !current.readOnly
      && !current.foregroundHandoffActive && !current.credentialPromptActive
      && !terminalInputReadiness.isPreparing(sessionId)
      && !agentTerminalLeaseState.get(sessionId)
      && controller?.terminal.buffer.active.type === 'normal'
      && !controller.hasKnownCredentialPrompt();
  };
  return await readTerminalCurrentDirectory(session, mayProbe).catch(() => null);
}

export function openTerminalSftpPath(
  session: TerminalSession,
  path: string,
  options?: Pick<SftpLocationRequest, 'entryName' | 'uploadPaths'>,
): boolean {
  const profile = session.profileId && useProfileStore.getState().getProfile(session.profileId);
  if (!profile || !isAbsoluteTerminalPath(session, path)) return false;
  const routeKey = session.sshRouteKey;
  if (!routeKey && (session.host !== profile.host || session.port !== profile.port
    || session.username !== profile.username || profile.jumpHost)) return false;
  return openHostPath(profile, path, 'sftp', 'remote', { path, routeKey: routeKey ?? sshRouteKey(profile), ...options });
}

export async function revealTerminalCurrentDirectory(sessionId: string): Promise<boolean> {
  const path = await getTerminalMenuDirectory(sessionId, false);
  if (!path || !useTerminalStore.getState().sessions.some((session) => session.sessionId === sessionId)) return false;
  await invokeRevealPath(path);
  return true;
}
