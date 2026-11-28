import type { AgentSudoPromptEvent } from '@/lib/ipc/tauri';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { DesktopNotificationTarget, DesktopNotificationUrgency } from '@/types';
import { sanitizeNotificationText } from './policy';

export type AiNotificationKind = 'approval' | 'question' | 'sudo' | 'completed' | 'failed';

export interface AgentNotificationCandidate {
  readonly kind: AiNotificationKind;
  readonly dedupeKey: string;
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  readonly detail?: string;
  readonly account?: string;
  readonly target: DesktopNotificationTarget;
  readonly urgency: DesktopNotificationUrgency;
}

interface SessionMetadata {
  title?: string;
  parentSessionId?: string;
  terminalSessionId?: string;
  activeTurnId?: string;
  settledTurnIds: Set<string>;
}

const MAX_SEEN_KEYS = 512;
const MAX_TRACKED_SESSIONS = 256;

export class AgentNotificationMonitor {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly seenKeys = new Set<string>();

  private getOrCreateSession(sessionId: string): SessionMetadata {
    let meta = this.sessions.get(sessionId);
    if (!meta) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
        }
      }
      meta = { settledTurnIds: new Set() };
      this.sessions.set(sessionId, meta);
    }
    return meta;
  }

  private resolveRootSessionId(sessionId: string): string {
    let current = sessionId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.sessions.get(current)?.parentSessionId;
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  private claimKey(key: string): boolean {
    if (this.seenKeys.has(key)) {
      return false;
    }
    if (this.seenKeys.size >= MAX_SEEN_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) {
        this.seenKeys.delete(oldest);
      }
    }
    this.seenKeys.add(key);
    return true;
  }

  private buildAgentTarget(sessionId: string): DesktopNotificationTarget {
    const rootSessionId = this.resolveRootSessionId(sessionId);
    const terminalSessionId = this.sessions.get(rootSessionId)?.terminalSessionId
      ?? this.sessions.get(sessionId)?.terminalSessionId;
    return {
      type: 'agentSession',
      agentSessionId: rootSessionId,
      ...(terminalSessionId ? { terminalSessionId } : {}),
    };
  }

  observeSessionEvent(event: AgentSessionEvent): AgentNotificationCandidate | null {
    const meta = this.getOrCreateSession(event.sessionId);

    switch (event.type) {
      case 'session/created': {
        if (event.data.parentSessionId) {
          meta.parentSessionId = event.data.parentSessionId;
        }
        if (event.data.target?.sessionId) {
          meta.terminalSessionId = event.data.target.sessionId;
        }
        if (!meta.title) {
          const fallback = event.data.goal || event.data.target?.label;
          if (fallback) {
            meta.title = sanitizeNotificationText(fallback, 80);
          }
        }
        return null;
      }

      case 'session/renamed': {
        const renamed = sanitizeNotificationText(event.data.title, 80);
        if (renamed) {
          meta.title = renamed;
        }
        return null;
      }

      case 'session/terminal_reconnected': {
        if (event.data.target?.sessionId) {
          meta.terminalSessionId = event.data.target.sessionId;
        }
        return null;
      }

      case 'turn/start': {
        if (event.turnId) {
          meta.activeTurnId = event.turnId;
        }
        return null;
      }

      case 'tool/approval': {
        if (event.data.status !== 'requested') {
          return null;
        }
        const dedupeKey = `approval:${event.sessionId}:${event.data.approvalId ?? event.data.requestId ?? event.data.callId}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        const rootSessionId = this.resolveRootSessionId(event.sessionId);
        const sessionTitle = this.sessions.get(rootSessionId)?.title ?? meta.title;
        const detail = event.data.prompt ?? event.data.reason;
        return {
          kind: 'approval',
          dedupeKey,
          sessionId: rootSessionId,
          sessionTitle,
          detail: detail ? sanitizeNotificationText(detail, 140) : undefined,
          target: this.buildAgentTarget(event.sessionId),
          urgency: 'critical',
        };
      }

      case 'question/requested': {
        const dedupeKey = `question:${event.sessionId}:${event.data.identity.questionRequestId}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        const rootSessionId = this.resolveRootSessionId(event.sessionId);
        const sessionTitle = this.sessions.get(rootSessionId)?.title ?? meta.title;
        const firstQuestion = event.data.arguments.questions[0];
        const detail = firstQuestion?.header ?? firstQuestion?.question;
        return {
          kind: 'question',
          dedupeKey,
          sessionId: rootSessionId,
          sessionTitle,
          detail: detail ? sanitizeNotificationText(detail, 140) : undefined,
          target: this.buildAgentTarget(event.sessionId),
          urgency: 'critical',
        };
      }

      case 'skill/proposal_requested': {
        const dedupeKey = `skill-proposal:${event.sessionId}:${event.data.identity.proposalId}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        const rootSessionId = this.resolveRootSessionId(event.sessionId);
        const sessionTitle = this.sessions.get(rootSessionId)?.title ?? meta.title;
        const detail = event.data.proposal.name;
        return {
          kind: 'question',
          dedupeKey,
          sessionId: rootSessionId,
          sessionTitle,
          detail: detail ? sanitizeNotificationText(detail, 140) : undefined,
          target: this.buildAgentTarget(event.sessionId),
          urgency: 'normal',
        };
      }

      case 'app_action/proposal_requested': {
        const dedupeKey = `app-proposal:${event.sessionId}:${event.data.proposalId}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        const rootSessionId = this.resolveRootSessionId(event.sessionId);
        const sessionTitle = this.sessions.get(rootSessionId)?.title ?? meta.title;
        const detail = event.data.summary;
        return {
          kind: 'question',
          dedupeKey,
          sessionId: rootSessionId,
          sessionTitle,
          detail: detail ? sanitizeNotificationText(detail, 140) : undefined,
          target: this.buildAgentTarget(event.sessionId),
          urgency: 'normal',
        };
      }

      case 'turn/end': {
        // Child subagent turn endings report back to the parent agent rather than interrupting the user.
        if (meta.parentSessionId) {
          return null;
        }
        const turnKey = event.turnId ?? meta.activeTurnId ?? `seq-${event.seq}`;
        if (event.data.reason !== 'completed') {
          if (event.data.reason === 'cancelled') {
            meta.settledTurnIds.add(turnKey);
          }
          return null;
        }
        if (meta.settledTurnIds.has(turnKey)) {
          return null;
        }
        meta.settledTurnIds.add(turnKey);
        const dedupeKey = `turn-completed:${event.sessionId}:${turnKey}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        return {
          kind: 'completed',
          dedupeKey,
          sessionId: event.sessionId,
          sessionTitle: meta.title,
          target: this.buildAgentTarget(event.sessionId),
          urgency: 'normal',
        };
      }

      case 'agent/status':
      case 'session/ended': {
        if (meta.parentSessionId) {
          return null;
        }
        const status = event.data.status;
        if (status !== 'failed' && status !== 'completed') {
          return null;
        }
        const turnKey = event.turnId ?? meta.activeTurnId ?? `seq-${event.seq}`;
        if (meta.settledTurnIds.has(turnKey)) {
          return null;
        }
        meta.settledTurnIds.add(turnKey);
        const kind: AiNotificationKind = status === 'failed' ? 'failed' : 'completed';
        const dedupeKey = `turn-${kind}:${event.sessionId}:${turnKey}`;
        if (!this.claimKey(dedupeKey)) {
          return null;
        }
        return {
          kind,
          dedupeKey,
          sessionId: event.sessionId,
          sessionTitle: meta.title,
          detail: event.data.reason ? sanitizeNotificationText(event.data.reason, 140) : undefined,
          target: this.buildAgentTarget(event.sessionId),
          urgency: status === 'failed' ? 'critical' : 'normal',
        };
      }

      default:
        return null;
    }
  }

  observeSudoPrompt(event: AgentSudoPromptEvent): AgentNotificationCandidate | null {
    if (event.state !== 'requested') {
      return null;
    }
    const dedupeKey = `sudo:${event.promptId}`;
    if (!this.claimKey(dedupeKey)) {
      return null;
    }
    const host = event.host.includes(':') ? `[${event.host}]` : event.host;
    const account = sanitizeNotificationText(`${event.username}@${host}:${event.port}`, 120);
    return {
      kind: 'sudo',
      dedupeKey,
      account,
      target: { type: 'none' },
      urgency: 'critical',
    };
  }
}
