import { createAgentSessionAdapter } from './agent-session-adapter';
import { reduceAiComposer, type AiComposerEvent, type AiComposerState } from './composer-machine';
import type { AiCreateSessionInput, AiSessionAdapter, AiSubmitInput } from './session-adapter';
import type { AiSubmissionQueue } from './submission-queue';

export interface AiSubmissionContext { readonly key: string }

/** Admission belongs to the application session, not to a mounted editor.
 * Stores only uncommitted input/control state; durable history remains native. */
export class AiSubmissionMemory {
  readonly queues = new WeakMap<object, AiSubmissionQueue>();
  readonly sessionQueues = new Map<string, AiSubmissionQueue>();
  readonly ledger = new WeakMap<object, AiComposerState>();
  readonly sessionStates = new Map<string, AiComposerState>();
  readonly inputs = new Map<string, AiSubmitInput<'agent'>>();
  readonly creations = new WeakMap<object, Promise<Extract<AiCreateSessionInput, { kind: 'agent' }>>>();
  private readonly closedWorkspaces = new Map<string, AiSubmissionContext>();
  private readonly listeners = new Set<(context: AiSubmissionContext, state: AiComposerState) => void>();

  remember(context: AiSubmissionContext, state: AiComposerState): void {
    this.ledger.set(context, state);
    if (state.sessionId) {
      this.sessionStates.delete(state.sessionId);
      this.sessionStates.set(state.sessionId, state);
      if (this.sessionStates.size > 128) {
        for (const [id, entry] of this.sessionStates) {
          if (this.sessionStates.size <= 128) break;
          if (!entry.pendingSubmissions.length && !entry.failedDrafts.length) {
            this.sessionStates.delete(id);
            this.sessionQueues.delete(id);
          }
        }
      }
    }
    if (
      this.closedWorkspaces.get(context.key) === context
      && !state.pendingSubmissions.length
      && !state.failedDrafts.length
    ) {
      this.closedWorkspaces.delete(context.key);
    }
    for (const listener of [...this.listeners]) listener(context, state);
  }

  /** Control receipts belong to the session, including after navigation/unmount. */
  settleSession(context: AiSubmissionContext, sessionId: string, event: AiComposerEvent): void {
    const previous = this.sessionStates.get(sessionId);
    if (!previous) return;
    this.remember(context, reduceAiComposer(previous, event).state);
  }

  close(context: AiSubmissionContext): void {
    const state = this.stateFor(context);
    if (state && (state.pendingSubmissions.length > 0 || state.failedDrafts.length > 0)) {
      this.closedWorkspaces.set(context.key, context);
    } else {
      this.closedWorkspaces.delete(context.key);
    }
  }

  /** Remove automatic restoration links and retained state for archived/deleted conversations. */
  forgetClosedSession(sessionId: string): void {
    const remembered = this.sessionStates.get(sessionId);
    if (remembered) {
      for (const pending of remembered.pendingSubmissions) {
        this.inputs.delete(pending.clientOperationId);
      }
      for (const failed of remembered.failedDrafts) {
        this.inputs.delete(failed.id);
      }
    }
    for (const [workspace, context] of this.closedWorkspaces) {
      if (this.stateFor(context)?.sessionId === sessionId) this.closedWorkspaces.delete(workspace);
    }
    this.sessionQueues.delete(sessionId);
  }

  stateFor(context: AiSubmissionContext): AiComposerState | undefined {
    const remembered = this.ledger.get(context);
    return remembered?.sessionId ? this.sessionStates.get(remembered.sessionId) ?? remembered : remembered;
  }

  reopen(workspace: string): { context: AiSubmissionContext; state: AiComposerState } | undefined {
    const context = this.closedWorkspaces.get(workspace);
    const state = context && this.stateFor(context);
    return context && state && (state.pendingSubmissions.length || state.failedDrafts.length)
      ? { context, state } : undefined;
  }

  subscribe(listener: (context: AiSubmissionContext, state: AiComposerState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

const memories = new WeakMap<object, AiSubmissionMemory>();
let defaultAdapter: AiSessionAdapter<'agent'> | undefined;

export function sharedAgentSessionAdapter(): AiSessionAdapter<'agent'> {
  return defaultAdapter ??= createAgentSessionAdapter();
}

export function submissionMemoryFor(owner: object): AiSubmissionMemory {
  let memory = memories.get(owner);
  if (!memory) { memory = new AiSubmissionMemory(); memories.set(owner, memory); }
  return memory;
}
