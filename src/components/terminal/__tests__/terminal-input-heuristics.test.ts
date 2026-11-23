import { describe, expect, it } from 'vitest';
import {
  applyTrackedUserInput,
  inputLineNeedsContinuation,
  type TrackedUserInputState,
} from '../registry/terminal-input-heuristics';

describe('terminal-input-heuristics', () => {
  it('ignores SS3 escape sequences in tracked user input', () => {
    const state: TrackedUserInputState = {
      pendingUserInputText: '',
      submittedContinuationText: '',
      unverifiedUserSubmission: false,
    };

    applyTrackedUserInput(state, 'ls\u001bOA\u001bOP -la');
    expect(state.pendingUserInputText).toBe('ls -la');
  });

  it('handles unquoted backslash escapes and trailing backslash parity', () => {
    expect(inputLineNeedsContinuation("echo \\'")).toBe(false);
    expect(inputLineNeedsContinuation('echo \\"')).toBe(false);
    expect(inputLineNeedsContinuation('echo \\(')).toBe(false);
    expect(inputLineNeedsContinuation('echo \\\\')).toBe(false);
    expect(inputLineNeedsContinuation('echo \\')).toBe(true);
    expect(inputLineNeedsContinuation('echo \\\\\\')).toBe(true);
  });
});
