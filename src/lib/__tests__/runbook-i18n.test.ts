import { afterEach, describe, expect, it } from 'vitest';
import enUS from '@/locales/en-US';
import zhCN from '@/locales/zh-CN';
import { changeLocale, t } from '@/locales';
import { getLocalizedRunbookErrorMessage } from '@/lib/runbook-error';
import {
  parseRunbookText,
  runbookExampleForLocale,
} from '@/lib/runbook';
import { createRunbookJsonSchema } from '@/lib/runbook-schema';

function runbookKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale).filter((key) => key.startsWith('runbook.')).sort();
}

function variables(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)(?:[,}])/g)]
    .map((match) => match[1])
    .sort();
}

describe('runbook internationalization', () => {
  afterEach(async () => {
    await changeLocale('zh-CN');
  });

  it('keeps English and Chinese keys and interpolation variables aligned', () => {
    const englishKeys = runbookKeys(enUS);
    const chineseKeys = runbookKeys(zhCN);
    expect(englishKeys).toEqual(chineseKeys);
    for (const key of englishKeys) {
      expect(variables(enUS[key as keyof typeof enUS]))
        .toEqual(variables(zhCN[key as keyof typeof zhCN]));
    }
  });

  it('formats English counts with correct singular and plural forms', async () => {
    await changeLocale('en-US');
    expect(t('runbook.overview.itemCount', { count: 1 })).toBe('1 step');
    expect(t('runbook.overview.itemCount', { count: 2 })).toBe('2 steps');
    expect(t('runbook.editor.problems', { count: 1 })).toBe('1 Schema problem');
    expect(t('runbook.editor.problems', { count: 2 })).toBe('2 Schema problems');
  });

  it('localizes structured validation errors without changing their fallback message', async () => {
    let error: unknown;
    try {
      parseRunbookText('{');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('not valid JSON');

    await changeLocale('zh-CN');
    expect(getLocalizedRunbookErrorMessage(error)).toBe('Runbook：文档不是有效的 JSON。');
  });

  it('provides localized starter content and Schema help', async () => {
    const chineseDocument = parseRunbookText(runbookExampleForLocale('zh-CN'));
    expect(chineseDocument.name).toBe('安全重载 nginx');

    await changeLocale('zh-CN');
    const schema = createRunbookJsonSchema(t);
    expect(schema.description).toContain('保存在本地');
    expect(schema.properties?.id).toMatchObject({
      description: '用于审阅与执行证据的稳定标识。',
    });
  });
});
