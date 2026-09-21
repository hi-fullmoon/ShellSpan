import { describe, expect, it } from 'vitest';
import { aiErrorMessage } from '../error-message';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { initI18n, t } from '@/locales';

it.each([
  ['zh-CN', '子代理令牌预算超出上限，最多允许 80000 个令牌。'],
  ['en-US', 'Subagent token budget exceeds the limit of 80000 tokens.'],
] as const)('localizes the subagent budget and preserves its limit in %s', async (locale, expected) => {
  await initI18n(locale);
  expect(aiErrorMessage('subagentTokenBudgetExceeded: maximum 80000 tokens', t)).toBe(expected);
  expect(aiErrorMessage('Error: subagentTokenBudgetExceeded: maximum 80000 tokens', t)).toBe(expected);
});

describe.each([['zh-CN', zhCN], ['en-US', enUS]] as const)('AI error messages in %s', (_locale, messages) => {
  it.each([
    ['ephemeralInputUnavailable: no input was executed', 'ai.error.ephemeralInputUnavailable'],
    ['Error: ephemeralInputRecoveryRequired: repeated historical input', 'ai.error.ephemeralInputRecoveryRequired'],
    ['IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model', 'ai.workspace.images.error.model'],
    ['Error: IMAGE_SOURCE_LIMIT: source is too large', 'ai.workspace.images.error.limit'],
    ['IMAGE_CANCELLED', 'ai.workspace.images.error.cancelled'],
    ['INVALID_MODEL_SELECTION: route-8e7d5ff7-25b5-4526-a8fa-df932c19228c/k3', 'ai.error.invalidModelSelection'],
    ['INVALID_MODEL_SELECTION: stale route revision 1', 'ai.error.invalidModelSelection'],
    ['Error: INVALID_MODEL_SELECTION: no default route', 'ai.error.invalidModelSelection'],
  ] as const)('translates %s', (message, key) => {
    expect(aiErrorMessage(message, key => messages[key])).toBe(messages[key]);
  });

  it.each(['Unknown provider response', 'IMAGE_NEW_ERROR: diagnostics', 'INVALID_MODEL_SELECTION_OTHER: diagnostics', '请检查模型配置。'])('preserves unrecognized messages: %s', message => {
    expect(aiErrorMessage(message, key => messages[key])).toBe(message);
  });
});
