export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible';
export type AiProviderPreset = 'ollama' | 'openai' | 'deepseek' | 'minimax' | 'kimi' | 'custom';
export type AiReasoningEffort = 'low' | 'high' | 'max';
export type AiTaskKind = 'ask' | 'chat' | 'explainTerminal' | 'generateCommand';

export interface AiProviderConfig {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  reasoningEffort?: AiReasoningEffort;
  requiresApiKey: boolean;
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
