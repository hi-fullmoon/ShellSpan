import { terminalRegistry, type TerminalOutputFilter } from '@/components/terminal/registry/terminal-registry';
import type { TerminalSession } from '@/stores/terminalStore';

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

function isAbsoluteDirectory(session: TerminalSession, directory: string): boolean {
  const local = session.host === 'local' && session.port === 0;
  return local
    ? /^(?:\/|[A-Za-z]:[\\/])/.test(directory)
    : directory.startsWith('/') && !directory.includes('\\');
}

function queryCommand(session: TerminalSession, token: string): { command: string; terminator: string } {
  const windows = session.host === 'local' && session.port === 0
    && navigator.userAgent.toLowerCase().includes('windows');
  if (windows) {
    return {
      command: `$__ss_c=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).ProviderPath));[Console]::Write(([char]27).ToString()+']777;shellspan-cwd:${token}:'+$__ss_c+[char]7);Remove-Variable __ss_c`,
      terminator: '\r',
    };
  }
  return {
    command: `python3 -c 'import os,base64,sys;sys.stdout.write("\\x1b]777;shellspan-cwd:${token}:"+base64.b64encode(os.getcwd().encode()).decode()+"\\x07")'`,
    terminator: '\n',
  };
}

/**
 * Reads the directory owned by the interactive shell itself. The response is
 * carried in a private OSC sequence, so neither it nor the probe command is
 * rendered into the terminal. A partial user command is never disturbed.
 */
export async function readTerminalCurrentDirectory(session: TerminalSession): Promise<string | null> {
  const controller = terminalRegistry.get(session.sessionId);
  if (!controller || controller.hasPendingUserInput() || controller.hasUnverifiedUserSubmission()) return null;
  await controller.whenOutputReady();
  if (controller.hasPendingUserInput() || controller.hasUnverifiedUserSubmission()) return null;

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
      matchedDirectory = directory && isAbsoluteDirectory(session, directory) ? directory : null;
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
    const { command, terminator } = queryCommand(session, token);
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
