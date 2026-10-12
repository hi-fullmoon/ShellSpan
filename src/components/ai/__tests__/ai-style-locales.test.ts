import { describe, expect, it } from 'vitest';
import { initI18n, t } from '@/locales';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { PROVIDER_PROFILE_IDS } from '@/lib/ai/provider-contract';

describe('AI style audit translations', () => {
  it('keeps the complete bilingual key sets aligned', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
  });

  it.each(['zh-CN', 'en-US'] as const)('provides readable profiles and interpolated notices in %s', async locale => {
    await initI18n(locale);
    for (const profile of PROVIDER_PROFILE_IDS) {
      const label = t(`settings.ai.profileName.${profile}`);
      expect(label).not.toBe(profile);
      expect(label).not.toContain('settings.ai.');
    }
    expect(t('ai.workspace.tool.omittedLines', { count: 12 })).toBe(locale === 'zh-CN' ? '… 省略 12 行 …' : '… 12 lines omitted …');
    expect(t('ai.workspace.tool.omittedResults', { count: 12 })).toBe(locale === 'zh-CN' ? '… 省略 12 条结果 …' : '… 12 results omitted …');
    expect(t('ai.workspace.tool.inputLabel')).toBe(locale === 'zh-CN' ? '输入' : 'IN');
    expect(t('ai.workspace.tool.outputLabel')).toBe(locale === 'zh-CN' ? '输出' : 'OUT');
    expect(t('ai.workspace.localTarget')).toBe(locale === 'zh-CN' ? '本地' : 'local');
  });
});
