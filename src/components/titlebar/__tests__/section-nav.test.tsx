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
    });

    expect(useAppStore.getState().activeSection).toBe('terminal');
  });
});
