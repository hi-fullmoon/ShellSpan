export type AiProviderKind = 'ollama' | 'openAi' | 'openAiCompatible';
export type AiProviderPreset = 'ollama' | 'openai' | 'deepseek' | 'minimax' | 'kimi' | 'custom';
export type AiStructuredOutputMode = 'jsonSchema' | 'jsonObject' | 'prompt';
export type AiTaskKind = 'chat' | 'explainTerminal' | 'generateCommand' | 'diagnosticAgent';

export interface AiProviderConfig {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
  structuredOutput: AiStructuredOutputMode;
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
  task: Exclude<AiTaskKind, 'diagnosticAgent'>;
  status: 'streaming' | 'completed' | 'cancelled' | 'failed';
  providerId: string;
  conversationId?: string;
  sessionId?: string;
  context?: AiContext;
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

export interface AiSessionFile {
  conversation: AiConversation;
  messages: AiChatMessage[];
}

export type AgentRunPhase =
  | 'planning'
  | 'awaitingReview'
  | 'handedOff'
  | 'cancelled'
  | 'error';

export type AgentStepStatus =
  | 'running'
  | 'completed'
  | 'informational'
  | 'failed';

export interface DiagnosticAgentPlanStep {
  id: string;
  title: string;
  description: string;
  command: string;
  risk: 'readOnly' | 'stateChange' | 'destructive';
  evidenceIds: string[];
  impact: string;
  rollback: string;
  expected: {
    exitCode: number;
    stdoutContains: string[];
  };
  timeoutSeconds: number;
  safeToRetry: boolean;
}

export interface DiagnosticAgentEvidenceRequirement {
  id: string;
  description: string;
  source: 'context' | 'stepOutput';
  sourceStepId: string | null;
  maxAgeSeconds: number;
}

export interface DiagnosticAgentPlan {
  objective: string;
  target: string;
  assumptions: string[];
  summary: string;
  evidence: DiagnosticAgentEvidenceRequirement[];
  steps: DiagnosticAgentPlanStep[];
}

export interface AgentRunStep {
  id: string;
  kind: 'tool' | 'analysis' | 'command';
  title: string;
  description: string;
  command?: string;
  risk?: 'readOnly' | 'stateChange' | 'destructive';
  evidenceIds?: string[];
  impact?: string;
  rollback?: string;
  expected?: DiagnosticAgentPlanStep['expected'];
  timeoutSeconds?: number;
  safeToRetry?: boolean;
  status: AgentStepStatus;
}

export interface AgentRun {
  id: string;
  requestId: string;
  goal: string;
  sessionId: string;
  profileId?: string;
  contextLabel: string;
  contextSource?: 'terminal' | 'remoteHealth';
  contextObservedAt: number;
  phase: AgentRunPhase;
  summary?: string;
  plan?: DiagnosticAgentPlan;
  responseText: string;
  steps: AgentRunStep[];
  error?: string;
}
