import { describe, expect, it } from 'vitest';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import type { AgentSandboxCapability, AgentSandboxContract, AgentSessionEvent, AgentSessionSnapshot, CreateAgentSessionRequest } from '@/types/agent-session';
import { AGENT_SESSION_EVENT_VERSION } from '@/types/agent-session';

const capability: AgentSandboxCapability = {
  status: 'unavailable', files: false, network: false, processLifecycle: false,
  gaps: ['No verified production sandbox backend'],
};

function snapshot(): AgentSessionSnapshot {
  return {
    header: { sessionId: 'session', taskId: 'task', goal: 'Inspect project', executionSurface: 'direct', createdAtUnixMs: 1 },
    sandboxCapability: capability, status: 'idle', ended: false, archived: false, eventCount: 1,
    surface: { generation: 0, messages: [] }, inbox: { nextTurn: [], nextStep: [] }, task: { evidence: [] },
    recovery: { kind: 'idle', status: 'none', summary: 'Idle', lastCommittedSeq: 0 },
  };
}

function created(policy?: CreateAgentSessionRequest['sandboxPolicy']): Extract<AgentSessionEvent, { type: 'session/created' }> {
  return {
    version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session', seq: 0, timeUnixMs: 1, type: 'session/created',
    data: { taskId: 'task', goal: 'Inspect project', sandboxPolicy: policy, permissionMode: 'operator', executionSurface: 'direct' },
  };
}

describe('sandbox session wire and recovery projection', () => {
  it('projects policy revision and historical resource audit without restoring capability or authorization', () => {
    const events: AgentSessionEvent[] = [created('workspace'),
      {version:5,sessionId:'session',seq:1,timeUnixMs:2,turnId:'turn',stepId:'step',type:'sandbox/resource_audit',data:{callId:'call',audit:{action:'approved',scope:'session',resources:[{kind:'writePath',path:'/tmp/project-cache'}],bindingRevision:0,callExpiresAtUnixMs:1000,sessionExpiresAtUnixMs:5000,cleanupConfirmed:null}}},
      {version:5,sessionId:'session',seq:2,timeUnixMs:3,type:'session/sandbox_policy_changed',data:{policy:'readOnly'}},
    ];
    const view=agentSessionView({snapshot:snapshot(),events,hasTerminalEvent:false});
    expect(view.snapshot.value.header.sandboxPolicy).toBe('readOnly');
    expect(view.snapshot.value.header.sandboxBindingRevision).toBe(2);
    expect(view.snapshot.value.sandboxCapability).toBeUndefined();
    expect(view.pendingApproval).toBeNull();
    expect(view.snapshot.value.header.permissionMode).toBeUndefined();
  });
  it('retains workspace intent and unavailable backend independently of approval', () => {
    const restored = snapshot();
    const event = created('workspace');
    const view = agentSessionView({ snapshot: restored, events: [event], hasTerminalEvent: false });
    expect(view.snapshot.value.header.sandboxPolicy).toBe('workspace');
    expect(view.snapshot.value.sandboxCapability).toEqual(capability);
    expect(event.data.permissionMode).toBe('operator');
    expect(view.pendingApproval).toBeNull();
  });

  it('preserves absent policy for legacy sessions and explicit host intent', () => {
    for (const policy of [undefined, 'host'] as const) {
      const view = agentSessionView({ snapshot: snapshot(), events: [created(policy)], hasTerminalEvent: false });
      expect(view.snapshot.value.header.sandboxPolicy).toBe(policy);
      expect(view.snapshot.value.sandboxCapability?.files).toBe(false);
    }
  });

  it('keeps frozen call audit and refusal events without inferring execution or isolation', () => {
    const contract: AgentSandboxContract = {
      version: 1, policy: 'workspace', target: { kind: 'local', targetId: 'local', sessionId: 'terminal' },
      bindingRevision: 0, sessionCreatedAtUnixMs: 1,
      executionSurface: 'direct', root: null, readAllow: [], writeAllow: [], deny: [], network: 'deny',
      source: 'session-intent', issuedAtUnixMs: 1, resourceGrants: [],
    };
    const events: AgentSessionEvent[] = [
      created('workspace'),
      { version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session', seq: 1, timeUnixMs: 2, type: 'sandbox/call_frozen', turnId: 'turn', stepId: 'step', data: { callId: 'call', contract } },
      { version: AGENT_SESSION_EVENT_VERSION, sessionId: 'session', seq: 2, timeUnixMs: 3, type: 'sandbox/start_rejected', data: { reason: 'sandboxBackendUnavailable' } },
    ];
    const view = agentSessionView({ snapshot: snapshot(), events, hasTerminalEvent: false });
    expect(view.snapshot.value.sandboxCapability?.status).toBe('unavailable');
    expect(view.snapshot.value.header.sandboxPolicy).toBe('workspace');
    expect(view.pendingApproval).toBeNull();
    expect(view.snapshot.value.status).toBe('idle');
  });
});
