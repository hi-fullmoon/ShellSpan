import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiQueueDock } from '../workspace/ai-queue-dock';
import { aiConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import { decodeDocumentMessage, encodeDocumentMessage } from '@/lib/ai/document-message';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiInboxItem } from '@/lib/ai/session-adapter';

const documents = [{ id: 'readme', name: 'README.md', size: 19, text: '# ShellSpan\nSSH client' }];
beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('document attachment surfaces', () => {
  it('keeps extracted content outside the editor and supports attachment-only submission', async () => {
    const user = userEvent.setup();
    let submitted = '';
    render(<AiComposerSeat phase="active" status="idle" defaultDraft={encodeDocumentMessage('', documents)} onSubmit={value => { submitted = value; }} />);
    expect(screen.getByRole('textbox')).toHaveTextContent('');
    expect(screen.getByText('README.md')).toBeVisible();
    expect(screen.getByText(/MD · .*Ready/)).toBeVisible();
    const card = screen.getByText('README.md').closest('[data-slot="attachment"]');
    expect(card).toHaveAttribute('data-orientation', 'vertical');
    expect(card?.parentElement).toHaveAttribute('data-slot', 'attachment-group');
    expect(card?.parentElement?.parentElement).toHaveAttribute('data-unified-attachments', 'true');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(decodeDocumentMessage(submitted)).toEqual({ text: '', documents });
    await user.click(screen.getByRole('button', { name: 'Remove README.md' }));
    expect(screen.queryByText('README.md')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('renders committed attachments as previewable cards without exposing their transport', async () => {
    const user = userEvent.setup();
    const UserMessage = aiConversationNodeRenderers.userMessage;
    render(<UserMessage node={{ kind: 'userMessage', key: 'message', sourceKind: 'agent', sessionId: 'session',
      turnId: 'turn', stepId: null, firstSeq: 1, lastSeq: 1, timestamp: '2026-09-20T00:00:00Z', messageId: 'message',
      delivery: 'committed', content: encodeDocumentMessage('Explain this project', documents) }} />);
    expect(screen.getByText('Explain this project')).toBeVisible();
    expect(screen.queryByText(/shellspanDocumentMessage/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Preview README.md' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('# ShellSpan');
    expect(dialog).toHaveClass('min-h-0', 'flex-col', 'overflow-hidden', 'p-0');
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass('shrink-0', 'px-4', 'pt-4');
    expect(dialog.querySelector('pre')).toHaveClass('px-4', 'pb-4');
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
  });

  it('preserves attachments when editing a queued prompt', async () => {
    const user = userEvent.setup();
    let saved = '';
    const item: AiInboxItem = { id: 'queued', lane: 'nextTurn', source: 'user', state: 'queued', content: encodeDocumentMessage('Explain this project', documents) };
    render(<AiQueueDock items={[item]} onUpdate={(_item, content) => { saved = content; }} />);
    expect(screen.getByText('Explain this project')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Edit/ }));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Summarize it');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(decodeDocumentMessage(saved)).toEqual({ text: 'Summarize it', documents });
  });
});
