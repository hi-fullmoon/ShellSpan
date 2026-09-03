import { persistAiMessage } from '@/lib/ai-sessions';
import {
  invokeArchiveAiSession,
  invokeCancelAiRequest,
  invokeCreateAiSession,
  invokeStartAiRequest,
  listenToAiStream,
} from '@/lib/tauri';
import { useAiStore } from '@/stores/aiStore';
import type { AiChatMessage, AiConversation, AiStreamEvent } from '@/types/ai';
import { projectAskConversationNodes } from './conversation-projection';
import type { AiConversationNode } from './conversation-node';
import type {
  AiApprovalDecisionInput,
  AiCreateSessionInput,
  AiSessionAdapter,
  AiSessionListener,
  AiSessionSummary,
  AiSessionSummaryPage,
  AiSessionView,
  AiSubmitInput,
  AiSubmitReceipt,
  ListSessionsInput,
} from './session-adapter';

type AskStoreState = ReturnType<typeof useAiStore.getState>;

interface AskStoreLike {
  getState(): AskStoreState;
  subscribe(listener: (state: AskStoreState) => void): () => void;
}

export interface AskSessionAdapterDependencies {
  readonly store: AskStoreLike;
  readonly start: typeof invokeStartAiRequest;
  readonly stop: typeof invokeCancelAiRequest;
  readonly listen: (listener: (event: AiStreamEvent) => void) => Promise<() => void>;
  readonly create: (conversation: AiConversation) => Promise<void>;
  readonly archive: (conversation: AiConversation) => Promise<void>;
  readonly persistMessage: (message: AiChatMessage) => Promise<void>;
}

const defaultDependencies: AskSessionAdapterDependencies = {
  store: useAiStore,
  start: invokeStartAiRequest,
  stop: invokeCancelAiRequest,
  listen: (listener) => listenToAiStream((event) => listener(event.payload)),
  create: (conversation) => invokeCreateAiSession({
    id: conversation.id,
    timestamp: conversation.startedAt,
    title: conversation.title,
    scope: conversation.scope,
    sessionId: conversation.sessionId,
    profileId: conversation.profileId,
    host: conversation.host,
    port: conversation.port,
    username: conversation.username,
  }),
  archive: (conversation) => invokeArchiveAiSession(
    conversation.id,
    conversation.startedAt,
    'new_conversation',
  ),
  persistMessage: persistAiMessage,
};

function scopedMessages(state: AskStoreState, sessionId: string): readonly AiChatMessage[] {
  return state.messages.filter((message) => message.conversationId === sessionId);
}

function requestBelongsTo(
  state: AskStoreState,
  requestId: string | undefined,
  sessionId: string,
): boolean {
  return requestId !== undefined && state.messages.some((message) => (
    message.requestId === requestId && message.conversationId === sessionId
  ));
}

function askStatus(state: AskStoreState, sessionId: string): AiSessionView['status'] {
  if (state.phase === 'streaming' && requestBelongsTo(state, state.activeRequestId, sessionId)) {
    return 'running';
  }
  if (state.phase === 'error' && requestBelongsTo(state, state.errorRequestId, sessionId)) {
    return 'failed';
  }
  return 'idle';
}

function askSummary(state: AskStoreState, conversation: AiConversation): AiSessionSummary {
  return {
    id: conversation.id,
    kind: 'ask',
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    status: askStatus(state, conversation.id),
    scopeKey: conversation.sessionId ?? conversation.scope ?? 'terminal',
    archived: conversation.archived,
    revision: null,
  };
}

export function askSessionView(
  state: AskStoreState,
  conversation: AiConversation,
): AiSessionView {
  const messages = scopedMessages(state, conversation.id);
  const ownsError = requestBelongsTo(state, state.errorRequestId, conversation.id);
  const nodes = projectAskConversationNodes({
    conversation,
    messages,
    phase: ownsError ? state.phase : askStatus(state, conversation.id) === 'running' ? 'streaming' : 'idle',
    error: ownsError ? state.error : undefined,
    errorRequestId: ownsError ? state.errorRequestId : undefined,
  });
  return {
    summary: askSummary(state, conversation),
    snapshot: {
      kind: 'ask',
      conversation,
      messages,
      phase: ownsError ? 'error' : askStatus(state, conversation.id) === 'running' ? 'streaming' : 'idle',
    },
    nodes,
    activity: null,
    inbox: [],
    pendingApproval: null,
    status: askStatus(state, conversation.id),
    error: ownsError && state.error
      ? { kind: 'unknown', message: state.error, retryable: true }
      : null,
    throughSeq: null,
    revision: null,
    committedOperationIds: [],
    canLoadOlder: false,
  };
}

/** Create the Ask adapter over the existing aiStore and AI stream commands. */
export function createAskSessionAdapter(
  dependencies: AskSessionAdapterDependencies = defaultDependencies,
): AiSessionAdapter<'ask'> {
  let stopStream: (() => void) | undefined;
  let streamReady: Promise<void> | undefined;
  let disposed = false;

  const conversation = (sessionId: string): AiConversation => {
    const found = dependencies.store.getState().conversations.find((item) => item.id === sessionId);
    if (!found) throw new Error(`Ask conversation ${sessionId} is unavailable`);
    return found;
  };

  const emitTerminalMessage = (requestId: string): void => {
    const assistant = dependencies.store.getState().messages.find((message) => (
      message.id === `assistant-${requestId}` && message.content.length > 0
    ));
    if (assistant) void dependencies.persistMessage(assistant);
  };

  const handleStream = (event: AiStreamEvent): void => {
    const state = dependencies.store.getState();
    switch (event.type) {
      case 'started':
        break;
      case 'textDelta':
        state.appendDelta(event.requestId, event.text);
        break;
      case 'completed':
        state.completeRequest(event.requestId);
        emitTerminalMessage(event.requestId);
        break;
      case 'cancelled':
        state.cancelRequest(event.requestId);
        emitTerminalMessage(event.requestId);
        break;
      case 'error':
        state.failRequest(event.requestId, event.message);
        emitTerminalMessage(event.requestId);
        break;
    }
  };

  const ensureStream = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Ask Session adapter is disposed'));
    streamReady ??= dependencies.listen(handleStream).then((stop) => {
      if (disposed) stop();
      else stopStream = stop;
    }).catch((error: unknown) => {
      streamReady = undefined;
      throw error;
    });
    return streamReady;
  };

  const createConversation = async (
    input: Extract<AiCreateSessionInput, { readonly kind: 'ask' }>,
  ): Promise<AiSessionView> => {
    dependencies.store.getState().upsertConversation(input.conversation);
    if (input.conversation.scope === 'workbench') {
      dependencies.store.getState().setActiveWorkbenchConversationId(input.conversation.id);
    }
    await dependencies.create(input.conversation);
    return askSessionView(dependencies.store.getState(), input.conversation);
  };

  return {
    kind: 'ask',
    async list(input: ListSessionsInput): Promise<AiSessionSummaryPage> {
      const state = dependencies.store.getState();
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      const matching = state.conversations
        .map((item) => askSummary(state, item))
        .filter((item) => (
          (input.scopeKey === undefined || item.scopeKey === input.scopeKey)
          && (input.archived === undefined || item.archived === input.archived)
        ))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const sessions = matching.slice(offset, offset + input.limit);
      const nextOffset = offset + sessions.length;
      return {
        sessions,
        nextCursor: nextOffset < matching.length ? String(nextOffset) : undefined,
      };
    },
    create: createConversation,
    async open(sessionId: string): Promise<AiSessionView> {
      const item = conversation(sessionId);
      return askSessionView(dependencies.store.getState(), item);
    },
    subscribe(sessionId: string, listener: AiSessionListener): () => void {
      const publish = (state: AskStoreState): void => {
        const item = state.conversations.find((candidate) => candidate.id === sessionId);
        if (item) listener(askSessionView(state, item));
      };
      const unsubscribe = dependencies.store.subscribe(publish);
      publish(dependencies.store.getState());
      void ensureStream().catch(() => undefined);
      return unsubscribe;
    },
    async submit(
      sessionId: string | null,
      input: AiSubmitInput<'ask'>,
    ): Promise<AiSubmitReceipt> {
      if (input.mode === 'nextStep') throw new Error('Ask sessions do not support next-step steering');
      const content = input.content.trim();
      if (!content) throw new Error('Ask submission content is empty');
      let resolvedSessionId = sessionId;
      if (resolvedSessionId === null) {
        if (!input.create) throw new Error('Ask submission requires create input for a new session');
        resolvedSessionId = (await createConversation(input.create)).summary.id;
      }
      const state = dependencies.store.getState();
      if (state.phase === 'streaming') throw new Error('An Ask request is already streaming');
      await ensureStream();
      const activeConversation = conversation(resolvedSessionId);
      const task = input.task ?? 'ask';
      const history = scopedMessages(state, resolvedSessionId)
        .filter((message) => message.task === task)
        .map(({ role, content }) => ({ role, content }));
      state.beginRequest({
        requestId: input.clientOperationId,
        task,
        userContent: content,
        providerId: input.provider.id,
        scope: activeConversation.scope,
        conversationId: resolvedSessionId,
        sessionId: activeConversation.sessionId,
        context: input.context,
      });
      const userMessage = dependencies.store.getState().messages.find((message) => (
        message.requestId === input.clientOperationId && message.role === 'user'
      ));
      if (userMessage) await dependencies.persistMessage(userMessage);
      try {
        await dependencies.start({
          requestId: input.clientOperationId,
          provider: input.provider,
          task,
          messages: [...history, { role: 'user', content }],
          context: input.context,
        });
      } catch (error) {
        dependencies.store.getState().failRequest(
          input.clientOperationId,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return {
        sessionId: resolvedSessionId,
        clientOperationId: input.clientOperationId,
        mode: input.mode,
      };
    },
    async stop(sessionId: string): Promise<void> {
      const state = dependencies.store.getState();
      if (!requestBelongsTo(state, state.activeRequestId, sessionId) || !state.activeRequestId) return;
      await dependencies.stop(state.activeRequestId);
    },
    async approve(_input: AiApprovalDecisionInput): Promise<void> {
      throw new Error('Ask sessions do not support approvals');
    },
    async reject(_input: AiApprovalDecisionInput): Promise<void> {
      throw new Error('Ask sessions do not support approvals');
    },
    async archive(sessionId: string): Promise<void> {
      const item = conversation(sessionId);
      await dependencies.archive(item);
      dependencies.store.getState().archiveConversation(sessionId);
    },
    async loadOlder(_sessionId: string, _cursor: string): Promise<readonly AiConversationNode[]> {
      return [];
    },
    async mutateInbox(): Promise<void> {
      throw new Error('Ask sessions do not support Runtime Inbox mutations');
    },
    async rename(): Promise<void> {
      throw new Error('Ask session rename is not part of the Agent Runtime contract');
    },
    async refresh(sessionId: string): Promise<AiSessionView> {
      return askSessionView(dependencies.store.getState(), conversation(sessionId));
    },
    async loadArtifact(_sessionId: string, _artifactId: string, _maxBytes: number) {
      throw new Error('Ask sessions do not support artifacts');
    },
    dispose(): void {
      disposed = true;
      stopStream?.();
      stopStream = undefined;
      streamReady = undefined;
    },
  };
}
