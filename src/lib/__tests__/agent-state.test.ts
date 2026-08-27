import { describe, expect, it } from 'vitest';
import stateFixture from '../../../tests/fixtures/agent-protocol/v1/state-transitions.json';
import {
  AGENT_RUN_STATES_V1,
  AGENT_RUN_TERMINAL_STATES_V1,
  AGENT_TOOL_CALL_STATES_V1,
  AGENT_TOOL_CALL_TERMINAL_STATES_V1,
  canTransitionAgentRunStateV1,
  canTransitionAgentToolCallStateV1,
  isAgentRunStateV1,
  isAgentRunTerminalStateV1,
  isAgentToolCallStateV1,
  isAgentToolCallTerminalStateV1,
  transitionAgentRunStateV1,
  transitionAgentToolCallStateV1,
} from '@/lib/agent-state';
import type { AgentRunStateV1, AgentToolCallStateV1 } from '@/types/agent';

describe('Agent state machines v1', () => {
  it('matches the shared Rust/TypeScript transition fixture exhaustively', () => {
    expect(stateFixture.schemaVersion).toBe(1);
    expect(AGENT_RUN_STATES_V1).toEqual(stateFixture.runStates);
    expect(AGENT_RUN_TERMINAL_STATES_V1).toEqual(stateFixture.runTerminalStates);
    expect(AGENT_TOOL_CALL_STATES_V1).toEqual(stateFixture.toolStates);
    expect(AGENT_TOOL_CALL_TERMINAL_STATES_V1).toEqual(stateFixture.toolTerminalStates);

    const runTransitions = new Set(stateFixture.runTransitions.map(([from, to]) => `${from}->${to}`));
    for (const from of AGENT_RUN_STATES_V1) {
      for (const to of AGENT_RUN_STATES_V1) {
        expect(canTransitionAgentRunStateV1(from, to), `${from} -> ${to}`)
          .toBe(runTransitions.has(`${from}->${to}`));
      }
    }

    const toolTransitions = new Set(stateFixture.toolTransitions.map(([from, to]) => `${from}->${to}`));
    for (const from of AGENT_TOOL_CALL_STATES_V1) {
      for (const to of AGENT_TOOL_CALL_STATES_V1) {
        expect(canTransitionAgentToolCallStateV1(from, to), `${from} -> ${to}`)
          .toBe(toolTransitions.has(`${from}->${to}`));
      }
    }
  });

  it('systematically rejects every late override of every terminal state', () => {
    for (const terminal of AGENT_RUN_TERMINAL_STATES_V1) {
      expect(isAgentRunTerminalStateV1(terminal)).toBe(true);
      for (const late of AGENT_RUN_STATES_V1) {
        expect(canTransitionAgentRunStateV1(terminal, late), `${terminal} -> ${late}`).toBe(false);
        expect(() => transitionAgentRunStateV1(terminal, late)).toThrow();
      }
    }
    for (const terminal of AGENT_TOOL_CALL_TERMINAL_STATES_V1) {
      expect(isAgentToolCallTerminalStateV1(terminal)).toBe(true);
      for (const late of AGENT_TOOL_CALL_STATES_V1) {
        expect(canTransitionAgentToolCallStateV1(terminal, late), `${terminal} -> ${late}`).toBe(false);
        expect(() => transitionAgentToolCallStateV1(terminal, late)).toThrow();
      }
    }
  });

  it('fails closed on unknown run and tool enum values', () => {
    expect(isAgentRunStateV1('running')).toBe(false);
    expect(isAgentToolCallStateV1('running')).toBe(false);
    expect(() => transitionAgentRunStateV1(
      'thinking',
      'running' as AgentRunStateV1,
    )).toThrow();
    expect(() => transitionAgentToolCallStateV1(
      'executing',
      'succeeded' as AgentToolCallStateV1,
    )).toThrow();
  });
});
