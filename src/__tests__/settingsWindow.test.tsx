// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../lib/i18n';
import SettingsWindow from '../SettingsWindow';

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
  }),
}));

describe('SettingsWindow', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/index.html?locale=en-US&theme=light#settings');
    delete document.documentElement.dataset.theme;
    await initI18n('zh-CN');
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('uses launch parameters for the first settings window render', () => {
    render(<SettingsWindow />);

    expect(screen.getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.queryByText('外观')).not.toBeInTheDocument();
  });
});
