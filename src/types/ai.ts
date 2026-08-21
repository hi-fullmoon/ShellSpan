export type AiProviderKind = 'ollama' | 'openAi';
export type AiTaskKind = 'chat' | 'explainTerminal' | 'generateCommand' | 'diagnosticAgent';

export interface AiProviderConfig {
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
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
}

export type AgentRunPhase =
  | 'idle'
  | 'planning'
  | 'awaitingApproval'
  | 'completed'
  | 'cancelled'
  | 'error';

export type AgentStepStatus =
  | 'running'
  | 'completed'
  | 'awaitingApproval'
  | 'approved'
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
