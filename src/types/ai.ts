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
  sessionId?: string;
  context?: AiContext;
}

export type AgentRunPhase =
  | 'idle'
  | 'planning'
  | 'awaitingApproval'
  | 'awaitingExecution'
  | 'evaluating'
  | 'completed'
  | 'cancelled'
  | 'error';

export type AgentStepStatus =
  | 'running'
  | 'completed'
  | 'informational'
  | 'queued'
  | 'awaitingApproval'
  | 'inserted'
  | 'superseded'
  | 'rejected'
  | 'failed';

export interface DiagnosticAgentPlanStep {
  title: string;
  description: string;
  command?: string;
}

export interface DiagnosticAgentPlan {
  summary: string;
  steps: DiagnosticAgentPlanStep[];
}

export interface AgentRunStep extends DiagnosticAgentPlanStep {
  id: string;
  kind: 'tool' | 'analysis' | 'command';
  status: AgentStepStatus;
  outputBaseline?: string;
  executionMarker?: string;
  exitCode?: number;
  result?: string;
}

export interface AgentRun {
  id: string;
  requestId: string;
  goal: string;
  sessionId: string;
  contextLabel: string;
  phase: AgentRunPhase;
  summary?: string;
  responseText: string;
  steps: AgentRunStep[];
  error?: string;
}
