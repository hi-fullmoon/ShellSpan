import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClipboardText, writeClipboardText } from '@/lib/clipboard';

const pluginWriteText = vi.hoisted(() => vi.fn());
const pluginReadText = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: pluginWriteText,
  readText: pluginReadText,
}));

describe('clipboard adapter', () => {
  beforeEach(() => {
    pluginWriteText.mockReset().mockResolvedValue(undefined);
    pluginReadText.mockReset().mockResolvedValue('');
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(''),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes writes through the Tauri plugin inside the Tauri runtime', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    await writeClipboardText('copied');
    expect(pluginWriteText).toHaveBeenCalledWith('copied');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('routes reads through the Tauri plugin inside the Tauri runtime', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    pluginReadText.mockResolvedValue('from plugin');
    await expect(readClipboardText()).resolves.toBe('from plugin');
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it('falls back to the web clipboard outside the Tauri runtime', async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue('from web');
    await writeClipboardText('copied');
    await expect(readClipboardText()).resolves.toBe('from web');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copied');
    expect(pluginWriteText).not.toHaveBeenCalled();
    expect(pluginReadText).not.toHaveBeenCalled();
  });

  it('propagates plugin write failures to the caller', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    pluginWriteText.mockRejectedValue(new Error('clipboard locked'));
    await expect(writeClipboardText('copied')).rejects.toThrow('clipboard locked');
  });
});
