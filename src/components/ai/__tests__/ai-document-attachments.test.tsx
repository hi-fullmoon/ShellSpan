import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiImageDraftRail } from '../workspace/ai-image-draft-rail';
import { AiDocumentAttachments } from '../workspace/ai-document-attachments';
import { AiQueueDock } from '../workspace/ai-queue-dock';
import { aiConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import { decodeDocumentMessage, encodeDocumentMessage } from '@/lib/ai/document-message';
import { DOCUMENT_LIMITS } from '@/lib/ai/document-import';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiInboxItem } from '@/lib/ai/session-adapter';

const documents = [{ id: 'readme', name: 'README.md', size: 19, text: '# ShellSpan\nSSH client' }];
beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('document attachment surfaces', () => {
  it.each([
    ['report.PDF', 'pdf', 'PDF', null],
    ['contract.docx', 'word', 'W', null],
    ['budget.xlsx', 'excel', 'X', null],
    ['table.csv', 'spreadsheet', null, 'lucide-file-spreadsheet'],
    ['README.md', 'markdown', 'MD', null],
    ['payload.json', 'json', '{}', null],
    ['settings.yaml', 'config', null, 'lucide-file-cog'],
    ['index.tsx', 'code', null, 'lucide-file-code'],
    ['notes.txt', 'text', null, 'lucide-file-text'],
  ])('shows the matching type icon above %s', (name, kind, mark, iconClass) => {
    render(<AiDocumentAttachments composer documents={[{ id: name, name, size: 1024, text: 'Content' }]} />);
    const card = screen.getByText(name).closest('[data-slot="attachment"]');
    expect(card).toHaveAttribute('data-file-kind', kind);
    expect(card?.querySelector('[title]')).toBeNull();
    const mediaIcon = card?.querySelector('[data-slot="attachment-media"] [data-slot="document-kind-icon"]');
    expect(mediaIcon).toHaveAttribute('aria-hidden', 'true');
    expect(mediaIcon?.tagName.toLowerCase()).toBe('svg');
    expect(card?.querySelector('[data-slot="attachment-content"] > svg')).toBeNull();
    if (mark) {
      expect(mediaIcon).toHaveAttribute('data-file-type-icon', kind);
      expect(mediaIcon).toHaveClass('size-4', 'group-data-[orientation=vertical]/attachment:size-6');
      expect(mediaIcon?.querySelector('text')).toHaveTextContent(mark);
    }
    if (iconClass) {
      expect(mediaIcon).toHaveClass(iconClass);
    }
  });

  it('renders an upper icon for every supported file extension', () => {
    const extensions = [...DOCUMENT_LIMITS.documentExtensions, ...DOCUMENT_LIMITS.textExtensions];
    const files = extensions.map((extension, index) => ({ id: String(index), name: `file-${index}.${extension}`, size: 1024, text: 'Content' }));
    render(<AiDocumentAttachments composer documents={files} />);
    const cards = screen.getAllByText(/^file-\d+\./u).map(title => title.closest('[data-slot="attachment"]'));
    expect(cards).toHaveLength(extensions.length);
    for (const card of cards) {
      expect(card?.querySelector('[data-slot="attachment-media"] svg[data-slot="document-kind-icon"]')).toBeInTheDocument();
      expect(card?.querySelector('[data-slot="attachment-content"] svg')).toBeNull();
    }
  });

  it('shows the full composer attachment title in a tooltip only when it is truncated', async () => {
    const user = userEvent.setup();
    const name = '2026-08-05-project-delivery-report.pdf';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function getScrollWidth(this: HTMLElement) {
      return this.textContent === name ? 240 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function getClientWidth(this: HTMLElement) {
      return this.textContent === name ? 80 : 0;
    });

    render(<AiDocumentAttachments composer documents={[{ id: name, name, size: 1024, text: 'Content' }]} />);
    const preview = screen.getByRole('button', { name: `Preview ${name}` });
    await user.hover(preview);

    await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(name);
    await user.click(preview);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the composer attachment title tooltip disabled when the full name fits', async () => {
    const user = userEvent.setup();
    const name = 'report.pdf';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function getScrollWidth(this: HTMLElement) {
      return this.textContent === name ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function getClientWidth(this: HTMLElement) {
      return this.textContent === name ? 80 : 0;
    });

    render(<AiDocumentAttachments composer documents={[{ id: name, name, size: 1024, text: 'Content' }]} />);
    await user.hover(screen.getByRole('button', { name: `Preview ${name}` }));

    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument();
  });

  it('places the import cancellation inside the pending attachment card', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<AiDocumentAttachments composer documents={[]} pending={[{ name: 'report.pdf', size: 1024 }]} onCancel={onCancel} />);
    const card = screen.getByText('report.pdf').closest('[data-slot="attachment"]');
    const action = screen.getByRole('button', { name: 'Cancel' });
    expect(card).toHaveAttribute('data-state', 'processing');
    expect(card).toHaveAttribute('data-file-kind', 'pdf');
    expect(card?.querySelector('[data-slot="attachment-media"] > [data-file-type-icon="pdf"] text')).toHaveTextContent('PDF');
    expect(card?.querySelector('[data-slot="attachment-media"] [data-slot="spinner"]')).toBeInTheDocument();
    expect(card?.querySelector('[data-slot="attachment-content"] svg')).toBeNull();
    const actions = card?.querySelector('[data-slot="attachment-actions"]');
    expect(actions).toContainElement(action);
    expect(actions).toHaveClass('absolute');
    expect(action).toHaveClass('ai-composer-file-remove', 'size-5', 'bg-secondary', 'hover:bg-secondary/80');
    await user.click(action);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps extracted content outside the editor and supports attachment-only submission', async () => {
    const user = userEvent.setup();
    let submitted = '';
    render(<AiComposerSeat phase="active" status="idle" defaultDraft={encodeDocumentMessage('', documents)} onSubmit={value => { submitted = value; }} />);
    expect(screen.getByRole('textbox')).toHaveTextContent('');
    expect(screen.getByText('README.md')).toBeVisible();
    expect(screen.getByText(/MD · .*Ready/)).toBeVisible();
    const card = screen.getByText('README.md').closest('[data-slot="attachment"]');
    expect(card).toHaveAttribute('data-orientation', 'vertical');
    expect(card).toHaveClass('focus-within:ring-0');
    expect(card?.querySelector('[data-slot="attachment-content"] svg')).toBeNull();
    expect(card?.parentElement).toHaveAttribute('data-slot', 'attachment-group');
    expect(card?.parentElement?.parentElement).toHaveAttribute('data-unified-attachments', 'true');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(decodeDocumentMessage(submitted)).toEqual({ text: '', documents });
    const remove = screen.getByRole('button', { name: 'Remove README.md' });
    expect(remove.closest('[data-slot="attachment-actions"]')).toHaveClass('absolute');
    expect(remove).toHaveClass('ai-composer-file-remove', 'size-5', 'bg-secondary', 'hover:bg-secondary/80');
    await user.click(remove);
    expect(screen.queryByText('README.md')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('keeps images and documents in one scrollable attachment strip', () => {
    const images = Array.from({ length: 5 }, (_, index) => ({ name: `image-${index}.png`, mediaType: 'image/png', data: 'aGVsbG8=' }));
    render(<AiComposerSeat phase="active" status="idle" defaultDraft={encodeDocumentMessage('', documents)}
      imageControls={<AiImageDraftRail images={images} busy={false} locked={false} error={false} onRemove={vi.fn()} />} />);
    const rail = screen.getByRole('group', { name: 'Attachments' });
    expect(rail).toHaveClass('w-full');
    expect(rail.querySelectorAll(':scope > [data-slot="attachment"]')).toHaveLength(6);
    expect(rail.lastElementChild).toHaveAttribute('data-document-name', 'README.md');
    let scrollLeft = 0;
    Object.defineProperties(rail, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 720 },
      scrollLeft: { configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value; } },
    });
    fireEvent.wheel(rail, { deltaY: 48 });
    expect(scrollLeft).toBe(48);
    fireEvent.wheel(rail, { deltaY: -24 });
    expect(scrollLeft).toBe(24);
  });

  it('keeps committed document previews without hover highlighting or pointer focus rings', async () => {
    const user = userEvent.setup();
    const UserMessage = aiConversationNodeRenderers.userMessage;
    render(<UserMessage node={{ kind: 'userMessage', key: 'message', sourceKind: 'agent', sessionId: 'session',
      turnId: 'turn', stepId: null, firstSeq: 1, lastSeq: 1, timestamp: '2026-09-20T00:00:00Z', messageId: 'message',
      delivery: 'committed', content: encodeDocumentMessage('Explain this project', documents) }} />);
    expect(screen.getByText('Explain this project')).toBeVisible();
    expect(screen.queryByText(/shellspanDocumentMessage/)).toBeNull();
    const card = screen.getByText('README.md').closest('[data-slot="attachment"]');
    expect(card).not.toHaveClass('focus-within:ring-1', 'has-[>a,>button]:hover:bg-muted/50');
    expect(card).toHaveAttribute('data-orientation', 'vertical');
    expect(card).toHaveClass('ai-composer-file-card');
    const rail = screen.getByRole('group', { name: 'Attachments' });
    expect(rail).toHaveClass('overflow-x-auto', 'overflow-y-hidden');
    expect(card?.parentElement).toBe(rail);
    expect(rail.parentElement).toHaveAttribute('data-unified-attachments', 'true');
    expect(screen.queryByRole('button', { name: 'Remove README.md' })).toBeNull();
    expect(card).toHaveClass('has-[:focus-visible]:ring-1');
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
