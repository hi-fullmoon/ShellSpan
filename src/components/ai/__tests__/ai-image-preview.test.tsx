import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCommittedImages } from '../workspace/ai-image-attachments';
import { AiImageDraftRail } from '../workspace/ai-image-draft-rail';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentImageRef } from '@/types/agent-image';

const preview = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc/tauri', () => ({ invokeAgentImagePreview: preview }));
const source = 'data:image/png;base64,aGVsbG8=';
const image: AgentImageRef = { version: 1, name: 'screenshot.png', sha256: 'image-hash', mediaType: 'image/png', width: 800, height: 600, bytes: 5 };

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  preview.mockReset().mockResolvedValue(source);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openPreview() {
  const trigger = await screen.findByRole('button', { name: 'Preview image screenshot.png' });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: image.name });
  fireEvent.load(within(dialog).getByRole('img'));
  return { trigger, dialog };
}

describe('chat image previews', () => {
  it('opens committed images, zooms within bounds, resets, closes with Escape, and restores focus', async () => {
    render(<AiCommittedImages sessionId="session-a" images={[image]} />);
    const { dialog, trigger } = await openPreview();
    expect(preview).toHaveBeenCalledWith({ sessionId: 'session-a', sha256: image.sha256 });
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', source);
    const zoomIn = within(dialog).getByRole('button', { name: 'Zoom in' });
    const zoomOut = within(dialog).getByRole('button', { name: 'Zoom out' });
    fireEvent.click(zoomIn);
    expect(within(dialog).getByText('125%')).toBeVisible();
    for (let i = 0; i < 20; i++) fireEvent.click(zoomIn);
    expect(zoomIn).toBeDisabled();
    expect(within(dialog).getByText('400%')).toBeVisible();
    for (let i = 0; i < 20; i++) fireEvent.click(zoomOut);
    expect(zoomOut).toBeDisabled();
    expect(within(dialog).getByText('25%')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset zoom' }));
    expect(within(dialog).getByText('100%')).toBeVisible();
    fireEvent.keyDown(dialog, { key: '+' });
    expect(within(dialog).getByText('125%')).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    expect(within(await screen.findByRole('dialog')).getByText('100%')).toBeVisible();
  });

  it('closes from the canvas and close control while image clicks stay inside the preview', async () => {
    const outerClick = vi.fn();
    render(<div onClick={outerClick}><AiCommittedImages sessionId="session-a" images={[image]} /></div>);
    const { dialog } = await openPreview();
    outerClick.mockClear();
    fireEvent.click(within(dialog).getByRole('img'));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(dialog.querySelector('.image-preview-stage')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(outerClick).not.toHaveBeenCalled();
    const reopened = await openPreview();
    await userEvent.click(within(reopened.dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps loading and unavailable attachments non-interactive and ignores stale session results', async () => {
    let resolveOld!: (url: string) => void;
    preview.mockImplementationOnce(() => new Promise<string>(resolve => { resolveOld = resolve; }));
    const { rerender } = render(<AiCommittedImages sessionId="session-a" images={[image]} />);
    expect(screen.queryByRole('button', { name: /Preview image/ })).not.toBeInTheDocument();
    preview.mockRejectedValueOnce(new Error('IMAGE_BLOB_MISSING'));
    rerender(<AiCommittedImages sessionId="session-b" images={[image]} />);
    await screen.findByRole('status');
    await act(async () => resolveOld(source));
    expect(screen.queryByRole('button', { name: /Preview image/ })).not.toBeInTheDocument();
  });

  it('reuses the preview for drafts without intercepting removal and handles image decode errors', async () => {
    const remove = vi.fn();
    render(<AiImageDraftRail images={[{ name: image.name, mediaType: 'image/png', data: 'aGVsbG8=' }]} busy={false} locked={false} error={false} onRemove={remove} />);
    const { dialog } = await openPreview();
    fireEvent.error(within(dialog).getByRole('img'));
    expect(within(dialog).getByRole('status')).toHaveTextContent('The image file is missing');
    expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Remove image screenshot.png' }));
    expect(remove).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
