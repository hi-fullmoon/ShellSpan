import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useDocumentImport } from '../workspace/use-document-import';
import { chatReferenceFile } from '@/lib/ai/chat-reference';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { decodeDocumentMessage } from '@/lib/ai/document-message';
import { DOCUMENT_LIMITS } from '@/lib/ai/document-import';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const summary: AiSessionSummary = {
  id: agentSessionEventFixture[0].sessionId, kind: 'agent', title: 'Check nginx now.',
  updatedAt: new Date(agentSessionEventFixture[0].timeUnixMs).toISOString(),
  status: 'idle', scopeKey: 'terminal-fixture', archived: false,
};
const reference = () => chatReferenceFile(summary, projectAgentChatNodes(agentSessionEventFixture));

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

it('claims the latest draft synchronously and prevents sending until the full reference is imported', async () => {
  let draft = '@nginx';
  let release!: (files: readonly File[]) => void;
  const loaded = new Promise<readonly File[]>(resolve => { release = resolve; });
  const { result } = renderHook(() => useDocumentImport('chat', () => draft, value => { draft = value; }, false));
  let imported!: Promise<boolean>;
  act(() => {
    draft = `${summary.title} What did this conversation cover?`;
    imported = result.current.addFrom(() => loaded, summary.title);
    expect(result.current.canSubmit()).toBe(false);
  });
  expect(result.current.busy).toBe(true);
  expect(draft).toBe(`${summary.title} What did this conversation cover?`);
  await act(async () => { release([reference()]); expect(await imported).toBe(true); });
  const message = decodeDocumentMessage(draft);
  expect(message.text).toBe(`${summary.title} What did this conversation cover?`);
  expect(JSON.parse(message.documents[0].text).messages).toEqual([
    { role: 'user', text: 'Check nginx now.' },
    { role: 'assistant', text: 'Checking now.' },
  ]);
  expect(result.current.canSubmit()).toBe(true);
});

it('blocks a failed title-only reference until it is removed or successfully retried', async () => {
  let draft = summary.title;
  const { result, rerender } = renderHook(() => useDocumentImport('chat', () => draft, value => { draft = value; }, false));
  await act(async () => {
    expect(await result.current.addFrom(async () => [chatReferenceFile(summary, [])], summary.title)).toBe(false);
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.canSubmit()).toBe(false);
  expect(decodeDocumentMessage(draft).documents).toHaveLength(0);
  draft = 'An unrelated question';
  rerender();
  expect(result.current.canSubmit()).toBe(true);
  draft = summary.title;
  rerender();
  expect(result.current.canSubmit()).toBe(false);
  await act(async () => { expect(await result.current.addFrom(async () => [reference()], summary.title)).toBe(true); });
  expect(result.current.canSubmit()).toBe(true);
  expect(decodeDocumentMessage(draft).documents).toHaveLength(1);
});

it('does not attach a cancelled reference and does not allow its unresolved title to be sent', async () => {
  let draft = summary.title;
  let release!: (files: readonly File[]) => void;
  const loaded = new Promise<readonly File[]>(resolve => { release = resolve; });
  const { result } = renderHook(() => useDocumentImport('chat', () => draft, value => { draft = value; }, false));
  let imported!: Promise<boolean>;
  act(() => { imported = result.current.addFrom(() => loaded, summary.title); });
  act(() => { result.current.cancel(); });
  await act(async () => { release([reference()]); expect(await imported).toBe(false); });
  expect(result.current.canSubmit()).toBe(false);
  expect(decodeDocumentMessage(draft).documents).toHaveLength(0);
});

it('rejects oversized reference text without truncating or sending the title alone', async () => {
  let draft = summary.title;
  const file = new File(['文'.repeat(DOCUMENT_LIMITS.maxCharacters + 1)], 'history.txt', { type: 'text/plain' });
  const { result } = renderHook(() => useDocumentImport('chat', () => draft, value => { draft = value; }, false));
  await act(async () => { expect(await result.current.addFrom(async () => [file], summary.title)).toBe(false); });
  expect(result.current.canSubmit()).toBe(false);
  expect(decodeDocumentMessage(draft).documents).toHaveLength(0);
});
