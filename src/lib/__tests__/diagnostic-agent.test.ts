import { describe, expect, it } from 'vitest';
import {
  buildAgentExecutionCommand,
  createAgentExecutionMarker,
  extractAgentCommandCompletion,
  extractAgentCommandResult,
  isSafeReadOnlyAgentCommand,
  parseDiagnosticAgentPlan,
} from '../diagnostic-agent';

describe('diagnostic agent plan', () => {
  it('parses a tagged plan with safe verification commands', () => {
    const plan = parseDiagnosticAgentPlan(`
      <agent_plan>{
        "summary": "The filesystem is nearly full.",
        "steps": [
          {"title": "Check usage", "description": "Inspect mounted filesystems.", "command": "df -h"},
          {"title": "Review", "description": "Confirm which mount is affected."}
        ]
      }</agent_plan>
    `);
    expect(plan.summary).toContain('filesystem');
    expect(plan.steps[0].command).toBe('df -h');
    expect(plan.steps[1].command).toBeUndefined();
  });

  it.each([
    'sudo df -h',
    'df -h && rm -rf /tmp/cache',
    'systemctl restart nginx',
    'find /tmp -delete',
    'find /tmp -fprint /tmp/agent-review',
    "rg --pre 'touch /tmp/agent-review' pattern .",
    'journalctl --vacuum-size=1M',
    'date -s 12:00:00',
    'hostname compromised-host',
    'ss -K dst 203.0.113.10',
    `df ${String.fromCharCode(3)}`,
    'cat /etc/hosts > /tmp/hosts',
    'tail -f /var/log/system.log',
    'journalctl -fu nginx',
    'journalctl -u nginx',
    'docker logs -f app',
    'docker logs app',
    'docker logs --tail all app',
    'docker stats',
    'docker stats --no-stream=false',
    'kubectl get pods --watch',
    'kubectl logs -f app',
    'kubectl logs app',
    'cat /dev/zero',
  ])('rejects unsafe commands: %s', (command) => {
    expect(isSafeReadOnlyAgentCommand(command)).toBe(false);
    expect(() => parseDiagnosticAgentPlan(JSON.stringify({
      summary: 'test',
      steps: [{ title: 'test', description: 'test', command }],
    }))).toThrow(/unsafe command/);
  });

  it.each([
    'df -h',
    'date -u +%FT%T',
    'hostname -f',
    'ss -lntp',
    'journalctl -u nginx -n 50',
    'systemctl status nginx',
    'docker logs --tail 200 app',
    'docker stats --no-stream',
    'kubectl logs app --tail=200',
  ])
    ('allows bounded read-only commands: %s', (command) => {
      expect(isSafeReadOnlyAgentCommand(command)).toBe(true);
    });

  it('rejects plans with more than eight steps', () => {
    expect(() => parseDiagnosticAgentPlan(JSON.stringify({
      summary: 'too many',
      steps: Array.from({ length: 9 }, (_, index) => ({
        title: `step ${index}`,
        description: 'test',
      })),
    }))).toThrow(/1-8 steps/);
  });

  it('extracts only terminal output added after command insertion', () => {
    const before = ['prompt', '$ uptime', 'up 10 days'].join('\n');
    const after = [
      'prompt',
      '$ uptime',
      'up 10 days',
      '$ df -h',
      '/dev/sda1 90%',
    ].join('\n');
    expect(extractAgentCommandResult(before, after)).toBe('$ df -h\n/dev/sda1 90%');
  });

  it('handles a rolling terminal buffer by matching the overlapping tail', () => {
    const before = ['old', 'shared 1', 'shared 2'].join('\n');
    const after = ['shared 1', 'shared 2', 'new result'].join('\n');
    expect(extractAgentCommandResult(before, after)).toBe('new result');
  });

  it('instruments safe commands and extracts the completion marker and exit code', () => {
    const marker = createAgentExecutionMarker('step-123');
    expect(buildAgentExecutionCommand('df -h', marker)).toBe(
      `df -h; printf '\\n${marker}:%s\\n' "$?"`,
    );
    const before = 'prompt\nold output';
    const after = [
      'prompt',
      'old output',
      'df -h',
      '/dev/sda1 90%',
      `${marker}:2`,
      'prompt',
    ].join('\n');
    expect(extractAgentCommandCompletion(before, after, marker)).toEqual({
      exitCode: 2,
      result: 'df -h\n/dev/sda1 90%',
    });
  });

  it('does not report command completion before the marker is present', () => {
    const marker = createAgentExecutionMarker('step-pending');
    expect(extractAgentCommandCompletion('', 'partial output', marker)).toBeUndefined();
  });
});
