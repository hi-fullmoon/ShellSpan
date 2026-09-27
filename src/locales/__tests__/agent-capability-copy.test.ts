import { describe, expect, it } from 'vitest';
import en from '../en-US';
import zh from '../zh-CN';

describe('Agent permission explanations', () => {
  it('describes automatic review without promising approval for unknown commands', () => {
    expect(zh['agent.permission.autoApproveReadOnly']).toBe('帮我批准');
    expect(zh['agent.permission.autoApproveReadOnlyDescription']).toContain('受限本地只读命令');
    expect(zh['agent.permission.composer.readOnlyDescription']).toContain('范围不明');
    expect(en['agent.permission.autoApproveReadOnlyDescription']).toContain('bounded local read commands');
    expect(en['agent.permission.composer.readOnlyDescription']).toContain('still ask');
  });
  it('distinguishes approval from child tool capabilities in both languages', () => {
    expect(zh['agent.permission.fullAccessWarning']).toContain('子代理仍受角色限制');
    expect(en['agent.permission.fullAccessWarning']).toContain('Child agents remain role-limited');
    expect(zh['agent.permission.composer.fullAccessDescription']).toContain('无需逐次批准');
    expect(en['agent.permission.composer.fullAccessDescription']).toContain('without per-call approval');
    expect(zh['agent.permission.fullAccessWarning']).toContain('命令尚无沙箱隔离');
    expect(en['agent.permission.fullAccessWarning']).toContain('Commands are not sandboxed');
    expect(zh['agent.permission.fullAccessSelected']).toBe('完全访问');
    expect(en['agent.permission.fullAccessSelected']).toBe('Full access');
  });
});
