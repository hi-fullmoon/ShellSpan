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

  it('centers minimum-width items with compact corners and decorative icons', () => {
    render(<SectionNav />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('min-w-20', 'shrink-0', 'justify-center', 'gap-1', 'whitespace-nowrap', 'rounded-lg');
      expect(button).not.toHaveClass('w-24');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(button.querySelector('svg')).not.toHaveClass('-translate-y-px');
      expect(button.querySelector('svg')).toHaveClass('size-3.5');
      expect(button).toHaveClass('min-h-7');
      expect(button.querySelector('span')).toHaveClass('[text-box:trim-both_text_alphabetic]');
    }
    expect(screen.getByRole('button', { name: 'section.workbench' })).toHaveAttribute('aria-current', 'page');
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
