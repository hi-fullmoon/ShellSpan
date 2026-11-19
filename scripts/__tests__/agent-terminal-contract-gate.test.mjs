import { describe, expect, it } from 'vitest';
import { selectedRustTests, checkRustTestResult, terminalContractFilters } from '../verification/agent/verify-agent-terminal-contracts.mjs';

describe('native Rust contract gate', () => {
  it('rejects the successful zero-match output produced by a retired module filter', () => {
    expect(() => selectedRustTests('0 tests, 0 benchmarks\n', 'agent::terminal')).toThrow('No Rust tests matched');
    expect(() => checkRustTestResult('test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1369 filtered out;\n', [])).toThrow('no passing tests');
  });

  it('requires the same selected tests to finish, with at least one real pass', () => {
    const selected = selectedRustTests('native::terminal_lease::first: test\r\nnative::terminal_lease::second: test\r\n\r\n2 tests, 0 benchmarks\r\n', 'terminal_lease');
    expect(checkRustTestResult('test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 5 filtered out;\n', selected)).toEqual({ passed: 1, ignored: 1 });
    expect(() => checkRustTestResult('test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 5 filtered out;\n', selected)).toThrow('no passing tests');
    expect(() => checkRustTestResult('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out;\n', selected)).toThrow('differs from its selected');
    expect(() => checkRustTestResult('test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 5 filtered out;\n', selected)).toThrow('completed native test suite');
  });

  it('keeps the executor namespace and existing broad lease filter', () => {
    expect(terminalContractFilters).toEqual(['agent_runtime::native::terminal_execute::tests::', 'terminal_lease']);
    expect(() => selectedRustTests('unrelated::test: test\n', 'terminal_lease')).toThrow('escaped its filter');
    expect(() => checkRustTestResult('', ['native::terminal_lease::first'])).toThrow('completed native test suite');
  });
});
