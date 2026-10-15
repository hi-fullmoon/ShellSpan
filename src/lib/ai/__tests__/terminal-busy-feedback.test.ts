import { describe, expect, it } from 'vitest';
import { projectAgentChatNodes } from '../conversation-projection';
import { latestTerminalBusyAttempt } from '../terminal-busy-feedback';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import type { AgentSessionEvent } from '@/types/agent-session';

const events = agentSessionBaselineScenarios['single-tool'].events;
const targetId = events.find(event => event.type === 'tool/call')?.data.call.target?.sessionId ?? '';

function rejectedEvents(code: string): readonly AgentSessionEvent[] {
  return events.map(event => event.type === 'tool/result'
    ? { ...event, data: { ...event.data, status: 'failed', summary: code } }
    : event);
}

describe('terminal busy rejection projection', () => {
  it.each(['TERMINAL_VISIBLE_COMMAND_BUSY', 'TERMINAL_BROKER_LEASE_BUSY', 'TERMINAL_LEASE_BUSY: terminal already has an Agent owner'])(
    'recognizes %s inside the projected turn process', code => {
      const nodes = projectAgentChatNodes(rejectedEvents(code));
      expect(nodes.some(node => node.kind === 'turnProcess')).toBe(true);
      expect(latestTerminalBusyAttempt(nodes, targetId)).toBe('tool:turn-01:step-01:call-terminal-01');
      expect(latestTerminalBusyAttempt(nodes, 'another-terminal')).toBeNull();
    },
  );

  it('does not classify successful commands, connection failures, or code prefixes as busy', () => {
    expect(latestTerminalBusyAttempt(projectAgentChatNodes(events), targetId)).toBeNull();
    for (const code of ['TERMINAL_VISIBLE_COMMAND_UNAVAILABLE', 'TERMINAL_EXECUTE_NOT_CONNECTED', 'TERMINAL_VISIBLE_COMMAND_BUSY_OTHER']) {
      expect(latestTerminalBusyAttempt(projectAgentChatNodes(rejectedEvents(code)), targetId)).toBeNull();
    }
  });

  it('also recognizes tools outside a turn process in a partial event window', () => {
    const toolEvents = rejectedEvents('TERMINAL_VISIBLE_COMMAND_BUSY').filter(event =>
      event.type === 'tool/call' || event.type === 'tool/execution' || event.type === 'tool/result')
      .map(event => ({ ...event, turnId: undefined, stepId: undefined }));
    const nodes = projectAgentChatNodes(toolEvents);
    expect(nodes.some(node => node.kind === 'tool')).toBe(true);
    expect(latestTerminalBusyAttempt(nodes, targetId)).not.toBeNull();
    expect(latestTerminalBusyAttempt(nodes, null)).toBeNull();
  });

  it('does not carry a previous input failure into the next input', () => {
    const nodes = projectAgentChatNodes(rejectedEvents('TERMINAL_VISIBLE_COMMAND_BUSY'));
    const input = nodes.find(node => node.kind === 'userMessage');
    expect(input).toBeDefined();
    expect(latestTerminalBusyAttempt([...nodes, input!], targetId)).toBeNull();
  });

  it('uses the newest terminal attempt rather than an earlier failed call', () => {
    const multiple = agentSessionBaselineScenarios['multiple-tools'].events.map(event =>
      event.type === 'tool/result' && event.data.callId === 'call-terminal-01'
        ? { ...event, data: { ...event.data, status: 'failed' as const, summary: 'TERMINAL_VISIBLE_COMMAND_BUSY' } }
        : event);
    expect(latestTerminalBusyAttempt(projectAgentChatNodes(multiple), targetId)).toBeNull();
  });
});
