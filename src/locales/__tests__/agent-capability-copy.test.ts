import { describe, expect, it } from 'vitest';
import en from '../en-US';
import zh from '../zh-CN';

describe('Agent permission explanations', () => {
  it('distinguishes approval from child tool capabilities in both languages', () => {
    expect(zh['agent.permission.fullAccessDescription']).toContain('角色工具范围限制');
    expect(en['agent.permission.fullAccessDescription']).toContain('role’s tools');
    expect(zh['agent.permission.composer.fullAccessDescription']).toContain('不会为子代理增加终端执行能力');
    expect(en['agent.permission.composer.fullAccessDescription']).toContain('does not grant terminal execution');
    expect(zh['agent.permission.fullAccessWarning']).toContain('符号链接限制');
    expect(en['agent.permission.fullAccessWarning']).toContain('symlink restrictions');
  });
});
