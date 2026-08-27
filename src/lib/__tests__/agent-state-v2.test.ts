import { describe, expect, it } from 'vitest';
import stateFixture from '../../../tests/fixtures/agent-protocol/v2/state-transitions.json';
import {
  AGENT_APPROVAL_STATES_V2,
  AGENT_APPROVAL_TERMINAL_STATES_V2,
  AGENT_RUN_STATES_V2,
  AGENT_RUN_TERMINAL_STATES_V2,
  AGENT_TOOL_CALL_STATES_V2,
  AGENT_TOOL_CALL_TERMINAL_STATES_V2,
  AGENT_VERIFICATION_STATES_V2,
  AGENT_VERIFICATION_TERMINAL_STATES_V2,
  canTransitionAgentApprovalStateV2,
  canTransitionAgentRunStateV2,
  canTransitionAgentToolCallStateV2,
  canTransitionAgentVerificationStateV2,
  isAgentApprovalStateV2,
  isAgentRunStateV2,
  isAgentToolCallStateV2,
  isAgentVerificationStateV2,
  transitionAgentApprovalStateV2,
  transitionAgentRunStateV2,
  transitionAgentToolCallStateV2,
  transitionAgentVerificationStateV2,
} from '@/lib/agent-state-v2';

describe('Agent state machines v2', () => {
  it('matches every shared transition fixture exhaustively', () => {
    expect(stateFixture.schemaVersion).toBe(2);
    assertMachine(
      AGENT_RUN_STATES_V2,
      stateFixture.runStates,
      stateFixture.runTransitions,
      canTransitionAgentRunStateV2,
    );
    expect(AGENT_RUN_TERMINAL_STATES_V2).toEqual(stateFixture.runTerminalStates);
    assertMachine(
      AGENT_TOOL_CALL_STATES_V2,
      stateFixture.toolStates,
      stateFixture.toolTransitions,
      canTransitionAgentToolCallStateV2,
    );
    expect(AGENT_TOOL_CALL_TERMINAL_STATES_V2).toEqual(stateFixture.toolTerminalStates);
    assertMachine(
      AGENT_APPROVAL_STATES_V2,
      stateFixture.approvalStates,
      stateFixture.approvalTransitions,
      canTransitionAgentApprovalStateV2,
    );
    expect(AGENT_APPROVAL_TERMINAL_STATES_V2).toEqual(stateFixture.approvalTerminalStates);
    assertMachine(
      AGENT_VERIFICATION_STATES_V2,
      stateFixture.verificationStates,
      stateFixture.verificationTransitions,
      canTransitionAgentVerificationStateV2,
    );
    expect(AGENT_VERIFICATION_TERMINAL_STATES_V2).toEqual(
      stateFixture.verificationTerminalStates,
    );
  });

  function assertMachine<T extends string>(
    states: readonly T[],
    fixtureStates: readonly string[],
    fixtureTransitions: readonly (readonly string[])[],
    canTransition: (from: T, to: T) => boolean,
  ): void {
    expect(states).toEqual(fixtureStates);
    const transitions = new Set(fixtureTransitions.map((transition) => {
      if (transition.length !== 2) throw new Error('Each state transition must contain two states');
      return `${transition[0]}->${transition[1]}`;
    }));
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(from, to), `${from} -> ${to}`)
          .toBe(transitions.has(`${from}->${to}`));
      }
    }
  }

  it('systematically rejects every late override of all four terminal sets', () => {
    assertTerminals(
      AGENT_RUN_TERMINAL_STATES_V2,
      AGENT_RUN_STATES_V2,
      canTransitionAgentRunStateV2,
      transitionAgentRunStateV2,
    );
    assertTerminals(
      AGENT_TOOL_CALL_TERMINAL_STATES_V2,
      AGENT_TOOL_CALL_STATES_V2,
      canTransitionAgentToolCallStateV2,
      transitionAgentToolCallStateV2,
    );
    assertTerminals(
      AGENT_APPROVAL_TERMINAL_STATES_V2,
      AGENT_APPROVAL_STATES_V2,
      canTransitionAgentApprovalStateV2,
      transitionAgentApprovalStateV2,
    );
    assertTerminals(
      AGENT_VERIFICATION_TERMINAL_STATES_V2,
      AGENT_VERIFICATION_STATES_V2,
      canTransitionAgentVerificationStateV2,
      transitionAgentVerificationStateV2,
    );
  });

  function assertTerminals<T extends string>(
    terminals: readonly T[],
    states: readonly T[],
    canTransition: (from: T, to: T) => boolean,
    transition: (from: T, to: T) => T,
  ): void {
    for (const terminal of terminals) {
      for (const late of states) {
        expect(canTransition(terminal, late), `${terminal} -> ${late}`).toBe(false);
        expect(() => transition(terminal, late)).toThrow();
      }
    }
  }

  it('fails closed on unknown enum values', () => {
    expect(isAgentRunStateV2('running')).toBe(false);
    expect(isAgentToolCallStateV2('succeeded')).toBe(false);
    expect(isAgentApprovalStateV2('accepted')).toBe(false);
    expect(isAgentVerificationStateV2('complete')).toBe(false);
  });
});
