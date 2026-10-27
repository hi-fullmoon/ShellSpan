import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/agent-skills-runtime.json';

const events = capture as AgentSessionEvent[];
const turnEnd = events.findIndex(event => event.type === 'turn/end');
const nodes = projectAgentChatNodes(events.slice(0, turnEnd)).filter(node => node.kind !== 'systemPrompt');

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

it('continues processing after recorded assistant output and clears the indicator when settled', () => {
  expect(nodes.some(node => node.kind === 'assistantMessage')).toBe(true);
  const { container, rerender } = render(<AiConversation nodes={nodes} status="running" throughSeq={null} />);
  const indicator = container.querySelector('[data-ai-running-indicator]');
  expect(indicator).toHaveTextContent('Processing');
  expect(indicator?.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
  expect(indicator).toHaveAttribute('role', 'status');
  expect(indicator).toHaveAttribute('aria-live', 'polite');
  for (const status of ['idle', 'completed', 'cancelled', 'failed'] as const) {
    rerender(<AiConversation nodes={nodes} status={status} throughSeq={null} />);
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
  }
});

it('uses the active process title while it is the last visible output', () => {
  const prefix = events.findIndex((_, index) => projectAgentChatNodes(events.slice(0, index + 1))
    .some(node => node.kind === 'turnProcess' && node.children.some(child => child.kind === 'contextInjection'
      && child.provenance.kind === 'skill-invocation')));
  expect(prefix).toBeGreaterThan(0);
  const processNodes = projectAgentChatNodes(events.slice(0, prefix + 1)).filter(node => node.kind !== 'systemPrompt');
  const { container } = render(<AiConversation nodes={processNodes} status="running" throughSeq={null} />);
  expect(container.querySelector('.ai-turn-process-trigger')).toHaveTextContent('Processing');
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
});

it.each([
  ['waitingForNetwork', 'Waiting for network recovery', '等待网络恢复'],
  ['toolApprovalPending', 'Waiting for your approval', '等待你批准操作'],
  ['waitingForUserQuestion', 'Waiting for your answer', '等待你回答问题'],
  ['waitingForTool', 'Waiting for the tool result', '等待工具执行结果'],
  ['toolSchedulerRecoveryRequired', 'Waiting for tool execution recovery', '等待工具执行恢复'],
  ['terminalExecutionRecoveryRequired', 'Execution paused: terminal recovery required', '执行已暂停，需要恢复终端'],
  ['ephemeralInputRecoveryRequired', 'Waiting for execution input recovery', '等待执行输入恢复'],
  ['authorizedCallRecoveryAvailable', 'Waiting for you to resume the authorized operation', '等待你恢复已授权的操作'],
  [undefined, 'Waiting (reason unavailable)', '等待中（未提供原因）'],
  ['futureReason', 'Waiting (reason unavailable)', '等待中（未提供原因）'],
] as const)('localizes the waiting reason %s and replaces it when execution resumes', async (reason, english, chinese) => {
  for (const [locale, label] of [['en-US', english], ['zh-CN', chinese]] as const) {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const { container, rerender, unmount } = render(
      <AiConversation nodes={nodes} status="waiting" statusReason={reason} throughSeq={null} />,
    );
    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent(label);
    expect(container.querySelector('[data-ai-running-indicator] [data-slot="spinner"]')).toBeNull();
    if (reason === 'terminalExecutionRecoveryRequired') {
      expect(container.querySelector('[data-ai-running-indicator] [data-slot="marker-content"]')).not.toHaveClass('shimmer');
    }
    rerender(<AiConversation nodes={nodes} status="running" statusReason={reason} throughSeq={null} />);
    expect(container.querySelector('[data-ai-running-indicator]')).toHaveTextContent(locale === 'en-US' ? 'Processing' : '处理中');
    rerender(<AiConversation nodes={nodes} status="waiting" statusReason={reason} runningIndicator="none" throughSeq={null} />);
    expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
    unmount();
  }
});
