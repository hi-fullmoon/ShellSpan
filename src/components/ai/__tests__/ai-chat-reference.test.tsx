import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent, { selectEditorText } from '@/test/composer-editor-user';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { chatReferenceFile } from '@/lib/ai/chat-reference';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';
import { decodeDocumentMessage, encodeDocumentMessage } from '@/lib/ai/document-message';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';

const summary: AiSessionSummary = {
  id: agentSessionEventFixture[0].sessionId, kind: 'agent', title: 'Check nginx now.',
  updatedAt: new Date(agentSessionEventFixture[0].timeUnixMs).toISOString(),
  status: 'idle', scopeKey: 'terminal-fixture', archived: false,
};
beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

it('inserts history inline like a skill and restores its payload with undo', async () => {
  const user = userEvent.setup();
  let submitted = '';
  const view = render(<AiComposerSeat phase="active" status="idle" sessions={[summary]}
    onReadSession={async () => chatReferenceFile(summary, projectAgentChatNodes(agentSessionEventFixture))}
    onSubmit={value => { submitted = value; }} />);
  await user.type(screen.getByRole('textbox'), 'before @nginx');
  await user.click(await screen.findByRole('option', { name: summary.title }));
  const editor = screen.getByRole('textbox');
  await waitFor(() => expect(editor.querySelector('[data-composer-chat-reference]')).toHaveClass('ai-composer-command'));
  expect(screen.queryByRole('group', { name: 'Attachments' })).toBeNull();
  await user.type(editor, 'after');
  expect(editor.textContent).toBe(`before ${summary.title} after`);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const decoded = decodeDocumentMessage(submitted);
  expect(decoded.documents[0].chatTitle).toBe(summary.title);
  expect(decoded.documents[0].text).toContain('Checking now.');
  view.unmount();
  render(<AiComposerSeat phase="active" status="idle" defaultDraft={encodeDocumentMessage(decoded.text, decoded.documents)}
    onSubmit={value => { submitted = value; }} />);
  const restored = screen.getByRole('textbox');
  expect(restored.querySelector('[data-composer-chat-reference]')).toHaveTextContent(summary.title);
  await user.click(restored);
  await act(async () => selectEditorText(restored, 7, 7 + summary.title.length));
  await user.keyboard('{Backspace}');
  expect(restored.textContent).toBe('before  after');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(decodeDocumentMessage(submitted).documents).toHaveLength(0);
  await user.keyboard('{Control>}z{/Control}');
  expect(restored.querySelector('[data-composer-chat-reference]')).toHaveTextContent(summary.title);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(decodeDocumentMessage(submitted).documents).toEqual(decoded.documents);
});

it('rejects invalid conversation display metadata', () => {
  const content = JSON.stringify({ shellspanDocumentMessage: 1, text: '', documents: [
    { id: 'history', name: 'history.txt', size: 1, text: 'x', chatTitle: 42 },
  ] });
  expect(decodeDocumentMessage(content)).toEqual({ text: content, documents: [] });
});

it('does not submit a failed history reference with Enter and allows retrying the reference', async () => {
  const user = userEvent.setup();
  const submissions: string[] = [];
  let emptyHistory = true;
  useToastStore.setState({ toasts: [] });
  render(<AiComposerSeat phase="active" status="idle" sessions={[summary]}
    onReadSession={async () => chatReferenceFile(summary, emptyHistory ? [] : projectAgentChatNodes(agentSessionEventFixture))}
    onSubmit={value => { submissions.push(value); }} />);
  const editor = screen.getByRole('textbox');
  await user.type(editor, '@nginx');
  await user.click(await screen.findByRole('option', { name: summary.title }));
  await waitFor(() => expect(useToastStore.getState().toasts.some(toast => toast.variant === 'error')).toBe(true));
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await user.keyboard('{Enter}');
  expect(submissions).toHaveLength(0);
  emptyHistory = false;
  await user.clear(editor);
  await user.type(editor, '@nginx');
  await user.click(await screen.findByRole('option', { name: summary.title }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  await user.keyboard('{Enter}');
  expect(submissions).toHaveLength(1);
  expect(JSON.parse(decodeDocumentMessage(submissions[0]).documents[0].text).messages).toEqual([
    { role: 'user', text: 'Check nginx now.' },
    { role: 'assistant', text: 'Checking now.' },
  ]);
});
