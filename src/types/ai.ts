export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible';
export type AiProviderPreset = 'ollama' | 'openai' | 'deepseek' | 'minimax' | 'kimi' | 'custom';
export type AiReasoningEffort = 'low' | 'high' | 'max';
export type AiTaskKind = 'ask' | 'chat' | 'explainTerminal' | 'generateCommand';
export type AiConversationScope = 'workbench' | 'terminal';

export interface AiProviderConfig {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  reasoningEffort?: AiReasoningEffort;
  requiresApiKey: boolean;
}

/** Used only while testing a provider setup; the key is never persisted. */
export interface AiProviderConnectionConfig extends AiProviderConfig {
  apiKey?: string;
}

export interface AiProviderProfile extends AiProviderConfig {
  name: string;
  preset: AiProviderPreset;
}

export interface AiMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiContext {
  label: string;
  content: string;
}

export interface AiStartRequest {
  requestId: string;
  provider: AiProviderConfig;
  task: AiTaskKind;
  messages: AiMessageInput[];
  context?: AiContext;
}

export type AiStreamEvent =
  | { type: 'started'; requestId: string }
  | { type: 'textDelta'; requestId: string; text: string }
  | { type: 'completed'; requestId: string }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; requestId: string; message: string };

export interface AiChatMessage extends AiMessageInput {
  id: string;
  requestId: string;
  task: AiTaskKind;
  status: 'streaming' | 'completed' | 'cancelled' | 'failed';
  providerId: string;
  /**
   * Identifies the app surface that owns an unbound conversation. Persisted
   * terminal messages are still primarily keyed by conversationId.
   */
  scope?: AiConversationScope;
  conversationId?: string;
  sessionId?: string;
  context?: AiContext;
}

export interface AiSessionRecovery {
  validRecords: number;
  skippedBytes: number;
  firstError: string;
}

export interface AiConversation {
  id: string;
  startedAt: string;
  updatedAt: string;
  title: string;
  archived: boolean;
  /** Missing on legacy files, which are treated as terminal conversations. */
  scope?: AiConversationScope;
  sessionId?: string;
  profileId?: string;
  host: string;
  port: number;
  username: string;
  recovery?: AiSessionRecovery;
}

export interface AiSessionMeta {
  id: string;
  timestamp: string;
  title: string;
  scope?: AiConversationScope;
  sessionId?: string;
  profileId?: string;
  host: string;
  port: number;
  username: string;
}

export interface AiSessionLocator {
  id: string;
  startedAt: string;
}

export interface AiSessionFile {
  conversation: AiConversation;
  messages: AiChatMessage[];
  agentStates?: import('./agent').PersistedAgentRunState[];
  recovery?: AiSessionRecovery;
}
