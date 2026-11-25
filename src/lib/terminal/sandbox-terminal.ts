import { invokeOpenLocalSandboxTerminal, isTauriRuntime } from '@/lib/ipc/tauri';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import type { AgentSandboxNetworkMode } from '@/stores/aiSettingsStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { LocalSandboxPtyBinding, SessionSummary } from '@/types';

const pendingOpens = new Map<string, Promise<SessionSummary | null>>();

export const SANDBOX_SYNC_UPDATED_EVENT = 'shellspan:sandbox-sync-updated';

export function notifySandboxSyncUpdated(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SANDBOX_SYNC_UPDATED_EVENT, { detail: sessionId }));
}

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return value.includes(':');
}

/** Mirrors `normalize_domain_rule` in `src-tauri/src/agent_runtime/native/sandbox_proxy.rs`. */
export function normalizeSandboxDomainRule(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed || trimmed.length > 253) return null;
  const wildcard = trimmed.startsWith('*.');
  const base = wildcard ? trimmed.slice(2) : trimmed;
  if (!base || base.includes('*') || isIpLiteral(base)) return null;
  const labels = base.split('.');
  if (labels.length < 2) return null;
  const validLabels = labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[a-z0-9-]+$/.test(label)
  ));
  if (!validLabels) return null;
  return wildcard ? `*.${base}` : base;
}

export function validateSandboxAllowlistInput(raw: string): {
  readonly valid: string[];
  readonly invalid: string[];
} {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const validSet = new Set<string>();
  const invalid: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeSandboxDomainRule(token);
    if (normalized) validSet.add(normalized);
    else invalid.push(token);
  }
  return { valid: Array.from(validSet), invalid };
}

export function hasSandboxPtyPolicyDrifted(
  binding: LocalSandboxPtyBinding,
  liveMode: AgentSandboxNetworkMode,
  liveAllowlist: readonly string[],
): boolean {
  if (binding.networkMode !== liveMode) return true;
  if (liveMode === 'customAllowlist' && binding.allowedDomains !== undefined) {
    const boundRules = Array.from(
      new Set(binding.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)),
    ).sort();
    const liveRules = Array.from(
      new Set(
        liveAllowlist
          .map((d) => normalizeSandboxDomainRule(d))
          .filter((d): d is string => d !== null),
      ),
    ).sort();
    if (boundRules.length !== liveRules.length) return true;
    return boundRules.some((rule, idx) => rule !== liveRules[idx]);
  }
  return false;
}

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

export function isManagedSandboxTerminalBusy(session: TerminalSession): boolean {
  return session.status === 'connecting'
    || session.promptReady === false
    || Boolean(session.foregroundHandoffActive);
}

export async function restartManagedSandboxTerminalIfOpen(
  agentSessionId: string,
  options?: Pick<EnsureSandboxTerminalOptions, 'formatTitle' | 'activate'>,
): Promise<'restarted' | 'not_open' | 'busy' | 'failed'> {
  if (!isTauriRuntime()) return 'not_open';
  const existing = findManagedSandboxTerminal(agentSessionId);
  if (!existing) return 'not_open';
  if (isManagedSandboxTerminalBusy(existing)) return 'busy';
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
