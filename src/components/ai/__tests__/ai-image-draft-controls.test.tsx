import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiDocumentAttachments } from '../workspace/ai-document-attachments';
import { AiImageDraftControls } from '../workspace/ai-image-attachments';
import { AiDraftAttachmentRail, AiImageDraftRail, UnifiedAttachmentContext } from '../workspace/ai-image-draft-rail';
import type { useImageDraft } from '../workspace/use-image-draft';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:upload') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('image draft controls', () => {
  it('keeps the upload cancel button on the pending image when a document follows it', async () => {
    const cancel = vi.fn(async () => {});
    const pending = new File(['pending'], 'upload.png', { type: 'image/png' });
    const state: ReturnType<typeof useImageDraft> = {
      owner: 'test',
      draft: { owner: 'test', revision: 1, text: '', images: [{ name: 'saved.png', mediaType: 'image/png', data: 'aGVsbG8=' }] },
      pendingFiles: [pending],
      busy: true,
      submittedOperationId: undefined,
      error: null,
      locked: false,
      add: async () => {},
      remove: async () => {},
      send: async () => {},
      cancel,
      reportError: () => {},
    };
    render(<UnifiedAttachmentContext value={true}>
      <AiDraftAttachmentRail unified count={3}>
        <AiImageDraftControls state={state} />
        <AiDocumentAttachments composer documents={[{ id: 'pdf', name: 'report.pdf', size: 12, text: 'report' }]} />
      </AiDraftAttachmentRail>
    </UnifiedAttachmentContext>);

    const rail = screen.getByRole('group', { name: 'Attachments' });
    const image = (await screen.findByRole('img', { name: 'upload.png' })).closest('[data-slot="attachment"]');
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(image?.querySelector('[data-slot="attachment-actions"]')).toContainElement(button);
    expect(image).toContainElement(button);
    expect(screen.queryByRole('button', { name: 'Remove image saved.png' })).toBeNull();
    expect(rail.querySelectorAll('[data-slot="attachment"]')).toHaveLength(3);
    expect(rail.querySelectorAll(':scope > [data-slot="attachment"]')).toHaveLength(3);
    expect(rail.querySelector('[data-document-name="report.pdf"]')).toBeInTheDocument();
    await act(async () => { await userEvent.click(button); });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('makes every visible image X cancel a locked submission', async () => {
    const cancel = vi.fn();
    render(<AiImageDraftRail images={['first.png', 'second.png'].map(name => ({ name, mediaType: 'image/png', data: 'aGVsbG8=' }))}
      busy={false} locked error={false} onRemove={vi.fn()} onCancel={cancel} />);
    const buttons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'first.png' }).closest('[data-slot="attachment"]')).toContainElement(buttons[0]);
    expect(buttons[0]).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Remove image/ })).toBeNull();
    await userEvent.click(buttons[0]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
