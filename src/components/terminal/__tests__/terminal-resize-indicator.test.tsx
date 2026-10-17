import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { TerminalResizeIndicator } from '../terminal-resize-indicator';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('TerminalResizeIndicator', () => {
  it('shows actual xterm columns and rows after resizing, then hides', async () => {
    const terminal = new Terminal();
    try {
      render(<TerminalResizeIndicator terminal={terminal} />);
      expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull();
      act(() => terminal.resize(107, 28));
      expect(screen.getByRole('status', { name: '107 columns × 28 rows' })).toHaveTextContent('107 × 28');
      act(() => terminal.resize(110, 32));
      expect(screen.getByRole('status', { name: '110 columns × 32 rows' })).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull(), { timeout: 1600 });
    } finally {
      terminal.dispose();
    }
  });

  it('stops listening when the indicator unmounts', () => {
    const terminal = new Terminal();
    try {
      const view = render(<TerminalResizeIndicator terminal={terminal} />);
      act(() => terminal.resize(107, 28));
      view.unmount();
      act(() => terminal.resize(120, 40));
      expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull();
    } finally {
      terminal.dispose();
    }
  });

  it('clears old dimensions and listens only to the replacement terminal', async () => {
    const first = new Terminal();
    const second = new Terminal();
    try {
      const view = render(<TerminalResizeIndicator terminal={first} />);
      act(() => first.resize(107, 28));
      expect(screen.getByRole('status', { name: '107 columns × 28 rows' })).toBeInTheDocument();

      view.rerender(<TerminalResizeIndicator terminal={second} />);
      expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull();
      act(() => first.resize(120, 40));
      expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull();

      act(() => second.resize(90, 20));
      expect(screen.getByRole('status', { name: '90 columns × 20 rows' })).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId('terminal-resize-indicator')).toBeNull(), { timeout: 1600 });
    } finally {
      cleanup();
      first.dispose();
      second.dispose();
    }
  });
});
