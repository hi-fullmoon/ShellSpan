import { describe, expect, it } from 'vitest';
import {
  AGENT_TERMINAL_AUDIT_ALLOWLIST,
  runAgentTerminalBoundaryAudit,
} from '../check-agent-terminal-boundaries.mjs';

describe('Agent terminal structured bypass and privacy audit', () => {
  it('accepts only the documented narrow command/import/schema boundaries', () => {
    const result = runAgentTerminalBoundaryAudit();
    expect(result.result).toBe('pass');
    expect(result.narrowCommands).toEqual(result.registeredCommands);
    expect(result.narrowCommands).toEqual([
      'agent_terminal_get_snapshot',
      'agent_terminal_resolve_approval',
      'agent_terminal_takeover_and_write',
      'agent_terminal_return_control',
      'agent_terminal_pause',
      'agent_terminal_stop',
    ]);
    expect(result.auditedDedicatedFiles).toHaveLength(5);
    expect(result.acceptance).toHaveLength(10);
  });

  it('keeps every exception narrow and documents why it is safe', () => {
    expect(Object.keys(AGENT_TERMINAL_AUDIT_ALLOWLIST)).toEqual([
      'ordinaryWriteSessionRegistration',
      'xtermDisplaySettingsStore',
      'xtermReadResizeTransport',
      'terminalThemeRegistry',
    ]);
    for (const reason of Object.values(AGENT_TERMINAL_AUDIT_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
