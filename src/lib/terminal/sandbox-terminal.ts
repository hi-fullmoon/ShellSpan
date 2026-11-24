import { invokeOpenLocalSandboxTerminal, isTauriRuntime } from '@/lib/ipc/tauri';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { SessionSummary } from '@/types';

const pendingOpens = new Map<string, Promise<SessionSummary | null>>();

export function findManagedSandboxTerminal(agentSessionId: string): TerminalSession | undefined {
  return useTerminalStore.getState().sessions.find(
    (session) => session.ptyInfo?.sandboxBinding?.agentSessionId === agentSessionId
      && session.status !== 'disconnected'
      && session.status !== 'error',
  );
}

export interface EnsureSandboxTerminalOptions {
  readonly insertAfterId?: string;
  readonly replacesSessionId?: string;
  readonly formatTitle?: (shell: string) => string;
  readonly activate?: boolean;
  readonly cols?: number;
  readonly rows?: number;
}

export async function ensureManagedSandboxTerminal(
  agentSessionId: string,
  options?: EnsureSandboxTerminalOptions,
): Promise<SessionSummary | null> {
  if (!isTauriRuntime()) return null;
  if (!options?.replacesSessionId) {
    const existing = findManagedSandboxTerminal(agentSessionId);
    if (existing) {
      useAgentPermissionStore.getState().setConversationSurface(existing.sessionId, {
        agentSessionId,
        surface: 'boundTerminal',
      });
      if (options?.activate !== false) {
        useTerminalStore.getState().setActiveSession(existing.sessionId);
      }
      return {
        sessionId: existing.sessionId,
        title: existing.title,
        host: existing.host,
        port: existing.port,
        username: existing.username,
        terminalSessionId: existing.terminalSessionId,
        terminalGeneration: existing.terminalGeneration,
        ptyInfo: existing.ptyInfo,
      };
    }
  }
  const key = options?.replacesSessionId ? `${agentSessionId}:replace:${options.replacesSessionId}` : agentSessionId;
  const inflight = pendingOpens.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<SessionSummary | null> => {
    const summary = await invokeOpenLocalSandboxTerminal(
      agentSessionId,
      options?.cols ?? 120,
      options?.rows ?? 30,
      options?.replacesSessionId,
    );
    const title = options?.formatTitle ? options.formatTitle(summary.title) : summary.title;
    const titledSummary: SessionSummary = { ...summary, title };
    const store = useTerminalStore.getState();
    store.addSession(titledSummary, undefined, {
      insertAfterId: options?.replacesSessionId ?? options?.insertAfterId,
      replacesSessionId: options?.replacesSessionId,
    });
    if (options?.replacesSessionId) {
      store.removeSession(options.replacesSessionId);
    }
    useAgentPermissionStore.getState().setConversationSurface(titledSummary.sessionId, {
      agentSessionId,
      surface: 'boundTerminal',
    });
    if (options?.activate !== false) {
      useTerminalStore.getState().setActiveSession(titledSummary.sessionId);
    }
    return titledSummary;
  })();

  pendingOpens.set(key, task);
  try {
    return await task;
  } finally {
    if (pendingOpens.get(key) === task) {
      pendingOpens.delete(key);
    }
  }
}

export async function restartManagedSandboxTerminalIfOpen(
  agentSessionId: string,
  options?: Pick<EnsureSandboxTerminalOptions, 'formatTitle' | 'activate'>,
): Promise<'restarted' | 'not_open' | 'failed'> {
  if (!isTauriRuntime()) return 'not_open';
  const existing = findManagedSandboxTerminal(agentSessionId);
  if (!existing) return 'not_open';
  try {
    const restarted = await ensureManagedSandboxTerminal(agentSessionId, {
      replacesSessionId: existing.sessionId,
      insertAfterId: existing.sessionId,
      formatTitle: options?.formatTitle,
      activate: options?.activate ?? false,
    });
    return restarted ? 'restarted' : 'failed';
  } catch {
    return 'failed';
  }
}
