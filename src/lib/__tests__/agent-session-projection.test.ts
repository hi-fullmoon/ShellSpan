import { describe, expect, it } from 'vitest';

import { projectAgentActivity } from '@/lib/agent-session-projection';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';

describe('Agent committed Activity projection', () => {
  it('projects status, turns, requests, tools, plan, context, agents, recovery and evidence', () => {
    const activity = projectAgentActivity(agentSessionEventFixture);

    expect(activity.sessionId).toBe('session-fixture');
    expect(activity.status).toBe('completed');
    expect(activity.turns[0]?.steps[0]?.request?.requestId).toBe('request-1');
    expect(activity.turns[0]?.steps[0]?.tools[0]?.callId).toBe('call-health');
    expect(activity.plan?.steps.length).toBeGreaterThan(0);
    expect(activity.context.artifacts.length).toBeGreaterThan(0);
    expect(activity.agents.some((agent) => agent.role === 'verifier')).toBe(true);
    expect(activity.evidenceCount).toBeGreaterThan(0);
  });

  it('accepts a contiguous page that begins after sequence zero', () => {
    const page = agentSessionEventFixture.slice(4, 12);
    expect(() => projectAgentActivity(page)).not.toThrow();
  });

  it('rejects gaps, mixed sessions, invalid timestamps, and unsupported versions', () => {
    const gap = [agentSessionEventFixture[0], agentSessionEventFixture[2]];
    expect(() => projectAgentActivity(gap)).toThrow('ordered and contiguous');

    const mixed = agentSessionEventFixture.slice(0, 2).map((event, index) => (
      index === 1 ? { ...event, sessionId: 'other-session' } : event
    ));
    expect(() => projectAgentActivity(mixed)).toThrow('cannot mix session ids');

    const invalidTime = [{ ...agentSessionEventFixture[0], timeUnixMs: 1.5 }];
    expect(() => projectAgentActivity(invalidTime)).toThrow('invalid timestamp');

    const unsupported = [{ ...agentSessionEventFixture[0], version: 99 }];
    expect(() => projectAgentActivity(unsupported as never)).toThrow('Unsupported');
  });
});
