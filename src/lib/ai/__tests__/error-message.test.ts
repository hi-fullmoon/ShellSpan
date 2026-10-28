import { describe, expect, it } from 'vitest';
import { aiErrorMessage, httpProbeTimeoutKind } from '../error-message';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { initI18n, t } from '@/locales';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';

it.each(['zh-CN', 'en-US'] as const)('localizes the recorded task budget error and retains its limit in %s', async locale => {
  await initI18n(locale);
  const error = taskTokenBudgetView().error!;
  const original = error.message;
  const summary = aiErrorMessage(original, t);
  expect(summary).toBe(t('ai.error.taskTokenBudgetExceeded', { maximum: 8510 }));
  expect(summary).not.toContain('taskTokenBudgetExceeded:');
  expect(error.message).toBe(original);
  expect(aiErrorMessage(`Error: ${original}; checkpointUnavailable`, t)).toBe(
    `${summary} ${t('ai.error.taskBudgetCheckpointUnavailable')}`,
  );
  expect(aiErrorMessage('taskActiveTimeExceeded: maximum 60000 active ms', t)).toBe(
    t('ai.error.taskActiveTimeExceeded', { seconds: 60 }),
  );
});

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
    ['retryable model failure: kind=RateLimited code=HTTP_429', 'ai.error.rateLimited'],
    ['network recovery after model transport failure', 'ai.error.connection'],
    ['providerFailure: status=401 code=HTTP_401', 'ai.error.authentication'],
    ['runtimeFailure: unspecified', 'ai.error.generic'],
    ['AGENT_UNSAFE_FILE_ROOT: symlink ancestor', 'ai.error.unsafeFileRoot'],
    ['TERMINAL_AGENT_CONFLICT: agent-owning-task', 'terminal.occupancy.conflict'],
    ['Error: TERMINAL_AGENT_CONFLICT', 'terminal.occupancy.conflict'],
    ['ephemeralInputUnavailable: no input was executed', 'ai.error.ephemeralInputUnavailable'],
    ['Error: ephemeralInputRecoveryRequired: repeated historical input', 'ai.error.ephemeralInputRecoveryRequired'],
    ['IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model', 'ai.workspace.images.error.model'],
    ['Error: IMAGE_SOURCE_LIMIT: source is too large', 'ai.workspace.images.error.limit'],
    ['IMAGE_CANCELLED', 'ai.workspace.images.error.cancelled'],
    ['INVALID_MODEL_SELECTION: route-8e7d5ff7-25b5-4526-a8fa-df932c19228c/k3', 'ai.error.invalidModelSelection'],
    ['INVALID_MODEL_SELECTION: stale route revision 1', 'ai.error.invalidModelSelection'],
    ['Error: INVALID_MODEL_SELECTION: no default route', 'ai.error.invalidModelSelection'],
    ['Target loopback HTTP request exceeded its total deadline; target loopback SSH transport exceeded its total deadline', 'ai.workspace.tool.httpProbe.timeout'],
    ['Target loopback HTTP request exceeded its total deadline', 'ai.workspace.tool.httpProbe.timeout'],
    ['target loopback SSH setup exceeded its total deadline', 'ai.workspace.tool.httpProbe.timeout'],
    ['Loopback HTTP probe timed out', 'ai.workspace.tool.httpProbe.timeout'],
  ] as const)('translates %s', (message, key) => {
    expect(aiErrorMessage(message, key => messages[key])).toBe(messages[key]);
  });

  it.each(['Unknown provider response', 'IMAGE_NEW_ERROR: diagnostics', 'INVALID_MODEL_SELECTION_OTHER: diagnostics', 'native policy rejects unscoped command network egress', '请检查模型配置。'])('preserves unrecognized messages: %s', message => {
    expect(aiErrorMessage(message, key => messages[key])).toBe(message);
  });
});

it('distinguishes a probe transport timeout from HTTP and unrelated failures', () => {
  expect(httpProbeTimeoutKind('Error: target loopback SSH setup exceeded its total deadline')).toBe('ssh');
  expect(httpProbeTimeoutKind('Target loopback HTTP request exceeded its total deadline')).toBe('http');
  expect(httpProbeTimeoutKind('probe_http exceeded its total deadline')).toBe('http');
  expect(httpProbeTimeoutKind('SSH authentication failed')).toBeNull();
  expect(httpProbeTimeoutKind('Target loopback HTTP request failed: connection reset')).toBeNull();
});
