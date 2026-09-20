import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { DragDropEvent } from '@tauri-apps/api/window';
import type { Event as TauriEvent } from '@tauri-apps/api/event';

const state = vi.hoisted(() => ({
  onDragDrop: null as ((event: TauriEvent<DragDropEvent>) => void) | null,
  pickFiles: vi.fn(),
  previewFile: vi.fn(),
  listDirectory: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: (handler: typeof state.onDragDrop) => { state.onDragDrop = handler; return Promise.resolve(() => {}); } }),
}));
vi.mock('@/lib/ipc/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/ipc/tauri')>(),
  isTauriRuntime: () => true,
  invokePickLocalFiles: state.pickFiles,
  invokePreviewLocalFile: state.previewFile,
  invokeListLocalDirectory: state.listDirectory,
}));

beforeEach(async () => {
  state.pickFiles.mockReset().mockResolvedValue(['/project/docs/spec.pdf']);
  state.previewFile.mockReset();
  state.listDirectory.mockReset().mockRejectedValue(new Error('file'));
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

describe('composer attachments', () => {
  it('adds a selected PNG from Add file through the image draft', async () => {
    state.pickFiles.mockResolvedValue(['/photos/example.png']);
    state.previewFile.mockResolvedValue({ name: 'example.png', content: btoa('image'), contentEncoding: 'base64', truncated: false });
    const onPasteImages = vi.fn();
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" onPasteImages={onPasteImages} />);
    await user.click(screen.getByRole('button', { name: 'Add file or folder' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add file' }));
    await waitFor(() => expect(onPasteImages).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'example.png', type: 'image/png' }),
    ]));
  });
  it('adds a selected PDF as a project file reference', async () => {
    const user = userEvent.setup();
    render(<AiComposerSeat phase="active" status="idle" onListFileReferences={async () => ({
      entries: [], status: 'ready', code: null, excluded: 0,
      scope: { root: '/project', rootIdentity: 'root', target: { kind: 'local', targetId: 'local', sessionId: 'session', cwd: '/project' } },
    })} />);
    await user.click(screen.getByRole('button', { name: 'Add file or folder' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add file' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('@docs/spec.pdf'));
  });
  it('adds a dropped folder and shows the drop target', async () => {
    state.listDirectory.mockResolvedValue({ path: '/project/docs space', entries: [] });
    const { container } = render(<AiComposerSeat phase="active" status="idle" onListFileReferences={async () => ({
      entries: [], status: 'ready', code: null, excluded: 0,
      scope: { root: '/project', rootIdentity: 'root', target: { kind: 'local', targetId: 'local', sessionId: 'session', cwd: '/project' } },
    })} />);
    const card = container.querySelector<HTMLElement>('[data-composer-card]')!;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 300, bottom: 200 } as DOMRect);
    const emit = (type: 'enter' | 'drop') => state.onDragDrop?.({ payload: {
      type, position: { x: 100, y: 100 }, paths: ['/project/docs space'],
    } } as TauriEvent<DragDropEvent>);
    act(() => emit('enter'));
    expect(card).toHaveClass('ring-2');
    expect(screen.getByRole('status')).toHaveTextContent('Drop to add files or folders');
    await act(async () => emit('drop'));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('@"docs space/"'));
  });
});
