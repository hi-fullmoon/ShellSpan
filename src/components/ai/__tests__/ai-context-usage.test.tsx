import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { projectContextUsage } from '@/lib/ai/context-usage';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/context-usage-runtime.json';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);
const usageAt = (stream: readonly AgentSessionEvent[], seq: number) =>
  projectContextUsage(stream.filter(event => event.seq <= seq));

it.each(['zh-CN', 'en-US'] as const)('keeps confirmation stable and estimates separate in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const user = userEvent.setup();
  const events = capture.requestTransitions as readonly AgentSessionEvent[];
  const { container, rerender } = render(<AiContextMeter usage={usageAt(events, 6507)} />);
  await user.click(screen.getByRole('button'));
  const header = container.ownerDocument.querySelector('.ai-context-meter-header')!;
  expect(header).toHaveTextContent('26%');
  expect(header).toHaveTextContent('81K / 312K');
  expect(header).not.toHaveTextContent('~');
  expect(screen.getByRole('dialog')).toHaveTextContent('~117K');
  expect(container.ownerDocument.querySelectorAll('.ai-context-meter-bar > span')).toHaveLength(1);
  rerender(<AiContextMeter usage={usageAt(events, 6684)} />);
  expect(header).toHaveTextContent('85.3K / 312K');
  rerender(<AiContextMeter usage={usageAt(events, 6710)} />);
  expect(header).toHaveTextContent('85.3K / 312K');
  expect(header).toHaveTextContent('27%');
  expect(screen.getByRole('dialog')).toHaveTextContent('~128K');
  expect(within(screen.getByRole('dialog')).getByText(locale === 'zh-CN' ? '最新输入估算' : 'Latest input estimate')).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each(['zh-CN', 'en-US'] as const)('clears pre-compaction usage without displaying zero in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const events = capture.compaction as readonly AgentSessionEvent[];
  const user = userEvent.setup();
  const { rerender } = render(<AiContextMeter usage={usageAt(events, 5640)} />);
  await user.click(screen.getByRole('button'));
  const panel = screen.getByRole('dialog');
  expect(panel).toHaveTextContent('142K / 312K');
  rerender(<AiContextMeter usage={usageAt(events, 5666)} />);
  expect(panel).not.toHaveTextContent('142K');
  expect(panel.querySelector('.ai-context-meter-header')).not.toHaveTextContent('0%');
  expect(panel).toHaveTextContent('— / 312K');
  expect(panel).toHaveTextContent(locale === 'zh-CN' ? '待确认' : 'Pending');
  expect(panel).toHaveTextContent(locale === 'zh-CN' ? '上下文已压缩' : 'Context compacted');
  expect(panel.querySelectorAll('[data-slot="ai-context-estimate"]')).toHaveLength(0);
  rerender(<AiContextMeter usage={usageAt(events, 5672)} />);
  expect(panel).toHaveTextContent('~62.5K / 312K');
  expect(panel).toHaveTextContent(locale === 'zh-CN' ? '压缩后估算' : 'After compaction');
  rerender(<AiContextMeter usage={usageAt(events, 5977)} />);
  expect(panel).toHaveTextContent('49.3K / 312K');
  expect(panel).toHaveTextContent(locale === 'zh-CN' ? '已确认占用' : 'Confirmed usage');
  expect(panel).not.toHaveTextContent(locale === 'zh-CN' ? '旧用量已清除' : 'previous usage was cleared');
});
