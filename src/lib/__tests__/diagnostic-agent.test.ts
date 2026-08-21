import { describe, expect, it } from 'vitest';
import {
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
    'cat /etc/hosts > /tmp/hosts',
  ])('rejects unsafe commands: %s', (command) => {
    expect(isSafeReadOnlyAgentCommand(command)).toBe(false);
    expect(() => parseDiagnosticAgentPlan(JSON.stringify({
      summary: 'test',
      steps: [{ title: 'test', description: 'test', command }],
    }))).toThrow(/unsafe command/);
  });

  it.each(['df -h', 'journalctl -u nginx -n 50', 'systemctl status nginx', 'docker logs app'])
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
});
