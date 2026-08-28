import type { AiProviderKind } from '@/types/ai';
import {
  AGENT_PERMISSION_MODES,
  AGENT_RISKS,
  type AgentApprovalDecision,
  type AgentContractStatus,
  type AgentPermissionMode,
  type AgentProviderCapabilityEvidence,
  type AgentProviderCapabilitySource,
  type AgentRiskClassification,
  type AgentTargetSnapshot,
} from '@/types/agent';

export const AGENT_CONTRACT_VERSION = 1 as const;
export const DEFAULT_AGENT_PERMISSION_MODE = 'requestApproval' as const;

export function classifyAgentRisk(value: unknown): AgentRiskClassification {
  return typeof value === 'string' && AGENT_RISKS.some((risk) => risk === value)
    ? { status: 'classified', risk: value as (typeof AGENT_RISKS)[number] }
    : { status: 'unknown' };
}

export function evaluateAgentPermission(
  mode: AgentPermissionMode | unknown,
  classification: AgentRiskClassification,
): AgentApprovalDecision {
  if (classification.status === 'unknown') {
    return { requiresApproval: true, reason: 'unclassifiedRisk' };
  }
  if (!AGENT_PERMISSION_MODES.some((permissionMode) => permissionMode === mode)) {
    return { requiresApproval: true, reason: 'modeRequiresApproval' };
  }
  if (mode === 'requestApproval') {
    return { requiresApproval: true, reason: 'modeRequiresApproval' };
  }
  if (mode === 'autoApproveReadOnly') {
    return classification.risk === 'readOnly'
      ? { requiresApproval: false, reason: 'readOnlyAutoApproved' }
      : { requiresApproval: true, reason: 'riskRequiresApproval' };
  }
  return { requiresApproval: false, reason: 'fullAccess' };
}

/**
 * Captures an owned, immutable connection-instance target. Later active-tab
 * changes cannot mutate the target carried by an Agent request or tool call.
 */
export function freezeAgentTarget(
  target: AgentTargetSnapshot,
): Readonly<AgentTargetSnapshot> {
  return Object.freeze({ ...target });
}

function expectedCapabilitySource(kind: AiProviderKind): AgentProviderCapabilitySource {
  switch (kind) {
    case 'openAi':
      return 'openAiResponses';
    case 'openAiCompatible':
      return 'chatCompletionsProbe';
    case 'ollama':
      return 'ollamaModelMetadata';
  }
}

export function resolveAgentProviderCapability(
  kind: AiProviderKind,
  evidence?: AgentProviderCapabilityEvidence,
): AgentProviderCapabilityEvidence {
  const source = expectedCapabilitySource(kind);
  if (!evidence) {
    return {
      support: kind === 'openAi' ? 'supported' : 'unknown',
      source,
    };
  }
  if (evidence.source !== source) return { support: 'unknown', source };
  return evidence;
}

export function resolveAgentContractStatus(
  featureEnabled: boolean,
  kind: AiProviderKind,
  evidence?: AgentProviderCapabilityEvidence,
): AgentContractStatus {
  const providerCapability = resolveAgentProviderCapability(kind, evidence);
  const agentAvailable = featureEnabled && providerCapability.support === 'supported';
  if (agentAvailable) {
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      featureEnabled,
      agentAvailable,
      defaultPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
      providerCapability,
    };
  }
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    featureEnabled,
    agentAvailable,
    defaultPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
    providerCapability,
    fallback: {
      task: 'generateCommand',
      automaticExecution: false,
      assistantTextExecution: 'forbidden',
      reason: !featureEnabled
        ? 'featureDisabled'
        : providerCapability.support === 'unsupported'
          ? 'toolCallingUnsupported'
          : 'toolCallingUnverified',
    },
  };
}
