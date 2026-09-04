import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { sessionEvent } from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';

afterEach(() => cleanup());

describe('terminal reasoning display', () => {
  it.each([
    ['zh-CN', '思考中…', '思考已中断', '过程失败'],
    ['en-US', 'Thinking…', 'Thinking interrupted', 'Process failed'],
  ] as const)('stops thinking after runtime failure in %s and when replaying history', async (
    locale, thinkingLabel, interruptedLabel, processLabel,
  ) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    const events = agentSessionBaselineScenarios['streaming-reasoning'].events
      .map((event) => ({ ...event, sessionId: `terminal-reasoning-${locale}` }));
    const view = render(<AiConversationNodeList nodes={projectAgentChatNodes(events)} />);
    expect(screen.getByText(thinkingLabel)).toHaveClass('shimmer');
    expect(view.container.querySelector('.ai-reasoning-row')).toHaveAttribute('role', 'status');

    const reason = 'runtimeFailure: assistant text block is invalid or exceeds 131072 bytes';
    const failedEvents = [
      ...events,
      { ...sessionEvent(events.length, {
        turnId: 'turn-01', stepId: 'step-01', type: 'step/end', data: { reason },
      }), sessionId: events[0].sessionId },
      { ...sessionEvent(events.length + 1, {
        turnId: 'turn-01', type: 'turn/end', data: { reason },
      }), sessionId: events[0].sessionId },
      { ...sessionEvent(events.length + 2, {
        type: 'session/ended', data: { status: 'failed', reason },
      }), sessionId: events[0].sessionId },
    ];
    const nodes = projectAgentChatNodes(failedEvents);
    view.rerender(<AiConversationNodeList nodes={nodes} />);
    await user.click(screen.getByRole('button', { name: processLabel }));

    async function expectStopped(container: HTMLElement) {
      expect(screen.queryByText(thinkingLabel)).not.toBeInTheDocument();
      expect(screen.getByText(interruptedLabel)).not.toHaveClass('shimmer');
      const row = container.querySelector('.ai-reasoning-row')!;
      expect(row).toHaveAttribute('data-state', 'interrupted');
      expect(row).not.toHaveAttribute('role', 'status');
      await user.click(screen.getByRole('button', { name: new RegExp(`^${interruptedLabel} `) }));
      expect(row.querySelector('.ai-reasoning-body')).toHaveTextContent(
        'Read the frozen context. Prepare a concise answer.',
      );
      expect(screen.getByText(reason)).toBeVisible();
    }

    await expectStopped(view.container);
    view.unmount();
    const replay = render(<AiConversationNodeList nodes={projectAgentChatNodes(failedEvents)} />);
    const process = screen.getByRole('button', { name: processLabel });
    if (process.getAttribute('aria-expanded') === 'false') await user.click(process);
    await expectStopped(replay.container);
  });
});
