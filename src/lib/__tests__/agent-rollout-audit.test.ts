import { describe, expect, it } from 'vitest';
import { AgentRolloutAuditor } from '@/lib/agent-rollout-audit';
import type { AgentRolloutPolicy, AgentRunRecord } from '@/types/agent';
import type { RecordOperationEventRequest } from '@/types/operation-history';

const previewPolicy: AgentRolloutPolicy = {
  stage: 'preview',
  featureEnabled: true,
  defaultAgentEnabled: true,
  defaultPermissionMode: 'requestApproval',
  availablePermissionModes: ['requestApproval', 'autoApproveReadOnly', 'fullAccess'],
  collectLocalDiagnostics: true,
};

const target = {
  kind: 'remote' as const,
  sessionId: 'session-preview',
  profileId: 'profile-preview',
  host: 'preview.example.test',
  port: 22,
  username: 'operator',
};

function previewRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    requestId: 'request-preview',
    conversationId: 'conversation-preview',
    conversationStartedAt: '2026-08-29T00:00:00.000Z',
    goal: 'Inspect secret=must-not-enter-preview-diagnostics',
    providerId: 'private-model-name',
    target,
    targetTitle: 'Sensitive target label',
    permissionMode: 'requestApproval',
    rolloutStage: 'preview',
    toolCallIds: [],
    phase: 'partial',
    status: 'partial',
    stopRequested: false,
    stepLimitReached: true,
    ...overrides,
  };
}

describe('Agent preview rollout audit', () => {
  it('records deduplicated compatibility classifications only during Preview', async () => {
    const events: RecordOperationEventRequest[] = [];
    const auditor = new AgentRolloutAuditor(async (event) => {
      events.push(event);
    });
    const capability = { support: 'unknown' as const, source: 'chatCompletionsProbe' as const };

    auditor.recordCompatibility(previewPolicy, 'openAiCompatible', capability, target);
    auditor.recordCompatibility(previewPolicy, 'openAiCompatible', capability, {
      ...target,
      sessionId: 'another-session',
    });
    auditor.recordCompatibility({ ...previewPolicy, stage: 'stable' }, 'openAi', {
      support: 'supported',
      source: 'openAiResponses',
    }, target);
    await auditor.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'agent',
      action: 'detectAgentProviderCapability',
      status: 'failed',
      errorCategory: 'toolCallingUnverified',
      subjectId: 'openAiCompatible:chatCompletionsProbe:unknown',
      targets: [target],
    });
  });

  it('stores categorical Preview outcomes without prompts, model identifiers, or output', async () => {
    const events: RecordOperationEventRequest[] = [];
    const auditor = new AgentRolloutAuditor(async (event) => {
      events.push(event);
    });
    const run = previewRun();

    auditor.recordRunOutcome(run);
    auditor.recordRunOutcome(run);
    auditor.recordRunOutcome(previewRun({ requestId: 'stable-run', rolloutStage: 'stable' }));
    await auditor.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: 'request-preview',
      operationId: 'request-preview',
      category: 'agent',
      action: 'runAgentTask',
      status: 'partialSuccess',
      errorCategory: 'stepLimit',
      subjectId: 'preview:partial',
      targets: [target],
      evidence: [],
    });
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain(run.goal);
    expect(encoded).not.toContain(run.providerId);
    expect(encoded).not.toContain(run.targetTitle);
    expect(encoded).not.toContain('must-not-enter-preview-diagnostics');
  });

  it('assigns a controlled fallback category to otherwise unclassified failures', async () => {
    const events: RecordOperationEventRequest[] = [];
    const auditor = new AgentRolloutAuditor(async (event) => {
      events.push(event);
    });

    auditor.recordRunOutcome(previewRun({
      requestId: 'unclassified-failure',
      phase: 'incomplete',
      status: 'failed',
      stepLimitReached: false,
      error: 'raw provider detail that must not enter diagnostics',
    }));
    await auditor.flush();

    expect(events[0]).toMatchObject({
      status: 'failed',
      errorCategory: 'unknown',
      subjectId: 'preview:incomplete',
    });
    expect(JSON.stringify(events)).not.toContain('raw provider detail');
  });
});
