import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SectionNav } from '../section-nav';
import { useAppStore } from '@/stores/appStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const initialState = useAppStore.getState();

describe('SectionNav', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it('keeps the navigation controls out of the Tauri drag region', () => {
    const { container } = render(<SectionNav />);

    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeInTheDocument();
  });

  it('activates a section when WKWebView only delivers pointerup', () => {
    render(<SectionNav />);
    expect(useAppStore.getState().activeSection).toBe('workbench');

    fireEvent.pointerUp(screen.getByRole('button', { name: 'section.terminal' }), {
      button: 0,
      pointerId: 12,
      pointerType: 'mouse',
    });

    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('activates immediately on pointerdown without duplicating the following click', () => {
    render(<SectionNav />);
    const terminal = screen.getByRole('button', { name: 'section.terminal' });
    const onStoreChange = vi.fn();
    const unsubscribe = useAppStore.subscribe(onStoreChange);

    try {
      fireEvent.pointerDown(terminal, { button: 0, pointerId: 12, pointerType: 'mouse' });
      expect(useAppStore.getState().activeSection).toBe('terminal');

      fireEvent.pointerUp(terminal, { button: 0, pointerId: 12, pointerType: 'mouse' });
      fireEvent.click(terminal, { detail: 1 });

      expect(useAppStore.getState().activeSection).toBe('terminal');
      expect(onStoreChange).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it('retains keyboard click activation', () => {
    render(<SectionNav />);

    fireEvent.click(screen.getByRole('button', { name: 'section.sftp' }), { detail: 0 });

    expect(useAppStore.getState().activeSection).toBe('sftp');
  });

  it('does not let a cancelled pointer sequence suppress the next click', () => {
    render(<SectionNav />);
    const terminal = screen.getByRole('button', { name: 'section.terminal' });
    Object.defineProperty(terminal, 'setPointerCapture', { value: vi.fn() });

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.pointerCancel(terminal, { pointerId: 12, pointerType: 'mouse' });
    useAppStore.getState().setActiveSection('workbench');
    fireEvent.click(terminal, { detail: 1 });

    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('expires pointerup-only click suppression when no click follows', () => {
    vi.useFakeTimers();
    try {
      render(<SectionNav />);
      const terminal = screen.getByRole('button', { name: 'section.terminal' });

      fireEvent.pointerUp(terminal, { button: 0, pointerId: 12, pointerType: 'mouse' });
      vi.runAllTimers();
      useAppStore.getState().setActiveSection('workbench');
      fireEvent.click(terminal, { detail: 1 });

      expect(useAppStore.getState().activeSection).toBe('terminal');
    } finally {
      vi.useRealTimers();
    }
  });
});
