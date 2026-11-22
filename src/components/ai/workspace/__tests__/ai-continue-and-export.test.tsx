import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAssistantMessageNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AiContinueGenerationContext, AiConversationNodeList } from '../ai-conversation-node-seat';
import { AiSessionHeader } from '../ai-session-header';

function makeAssistant(overrides: Partial<AiAssistantMessageNode>): AiAssistantMessageNode {
  return {
    kind: 'assistantMessage',
    key: 'assistant:1',
    sourceKind: 'agent',
    sessionId: 'sess-g',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 2,
    lastSeq: 3,
    timestamp: new Date().toISOString(),
    messageId: 'msg-1',
    requestId: 'req-1',
    blocks: [{ type: 'text', text: 'Partial answer before stop' }],
    state: 'cancelled',
    ...overrides,
  };
}

describe('continue after stop and markdown export header button', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  afterEach(cleanup);

  it('shows Continue only on the latest interrupted/cancelled assistant message and fires onContinue', () => {
    const onContinue = vi.fn();
    const older = makeAssistant({ key: 'assistant:old', messageId: 'msg-old', state: 'interrupted' });
    const latest = makeAssistant({ key: 'assistant:latest', messageId: 'msg-latest', state: 'cancelled' });

    render(
      <AiContinueGenerationContext.Provider value={{ latestAssistantKey: latest.key, busy: false, onContinue }}>
        <AiConversationNodeList nodes={[older, latest]} />
      </AiContinueGenerationContext.Provider>,
    );

    const buttons = screen.getAllByRole('button', { name: 'Continue' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('renders export button in header only when export handler is provided', () => {
    const onExport = vi.fn();
    const { rerender } = render(
      <AiSessionHeader title="Check" context="prod" status="idle" />,
    );
    expect(screen.queryByRole('button', { name: 'Export as Markdown' })).not.toBeInTheDocument();

    rerender(
      <AiSessionHeader title="Check" context="prod" status="idle" onExportMarkdown={onExport} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export as Markdown' }));
    expect(onExport).toHaveBeenCalledOnce();
  });
});
