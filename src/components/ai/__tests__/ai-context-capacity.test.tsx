import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { contextUsageForModel } from '@/lib/ai/session-settings';
import type { AiContextUsage } from '@/lib/ai/session-adapter';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import catalog from '../../../../protocol/llm/catalog.json';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const context = [...capture as readonly AgentSessionEvent[]].reverse().find(event => event.type === 'request/context');
if (context?.type !== 'request/context' || context.data.inputTokens === undefined
  || context.data.contextWindow === undefined) throw new Error('Recorded context evidence is required');
const usage: AiContextUsage = {
  usedTokens: context.data.inputTokens,
  contextWindow: context.data.contextWindow,
  source: 'estimated',
};
const originalWindow = catalog.presets.minimax.models['MiniMax-M3'].contextWindow;

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('updates capacity while preserving recorded usage in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const user = userEvent.setup();
  const { rerender } = render(<AiContextMeter usage={contextUsageForModel(usage, originalWindow)} />);
  await user.click(screen.getByRole('button'));
  const panel = screen.getByRole('dialog');
  expect(panel).toHaveTextContent('/ 1M');
  rerender(<AiContextMeter usage={contextUsageForModel(usage, 128_000)} />);
  expect(panel).toHaveTextContent('/ 128K');
  expect(panel).toHaveTextContent('7%');
  expect(panel).toHaveTextContent(locale === 'zh-CN'
    ? '容量按当前模型配置显示；占用数据来自上次请求'
    : 'Capacity reflects the current model configuration; usage is from the previous request');
  expect(contextUsageForModel(usage, 128_000)).toMatchObject({ usedTokens: usage.usedTokens, source: usage.source });
  // A later admitted request matching the configured capacity clears the stale-usage note.
  rerender(<AiContextMeter usage={contextUsageForModel(usage, usage.contextWindow)} />);
  expect(panel).not.toHaveTextContent(locale === 'zh-CN' ? '占用数据来自上次请求' : 'usage is from the previous request');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps unavailable or invalid model capacities from replacing request evidence', () => {
  expect(contextUsageForModel(undefined, 128_000)).toBeUndefined();
  for (const capacity of [undefined, 0, -1, 1.5, NaN, Infinity, usage.contextWindow]) {
    expect(contextUsageForModel(usage, capacity)).toBe(usage);
  }
});

it('does not clamp or overwrite usage when the selected capacity is smaller', async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  const smaller = contextUsageForModel(usage, usage.usedTokens - 1);
  expect(smaller?.usedTokens).toBe(usage.usedTokens);
  render(<AiContextMeter usage={smaller} />);
  expect(screen.getByRole('button')).toHaveAccessibleName('Estimated context usage 100%');
});
