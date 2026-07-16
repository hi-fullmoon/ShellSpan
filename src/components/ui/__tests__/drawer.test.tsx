import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Drawer, DrawerContent } from '../drawer';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('Drawer', () => {
  it('uses CSS transitions for the overlay and popup', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const overlay = document.body.querySelector('[data-slot="drawer-overlay"]');
    const content = document.body.querySelector('[data-slot="drawer-content"]');

    expect(overlay).toHaveClass('transition-opacity');
    expect(overlay).toHaveClass('duration-200');
    expect(overlay).toHaveClass('data-starting-style:opacity-0');
    expect(overlay).toHaveClass('data-ending-style:opacity-0');

    expect(content).toHaveClass('transition-transform');
    expect(content).toHaveClass('duration-200');
    expect(content).toHaveClass('data-starting-style:translate-x-full');
    expect(content).toHaveClass('data-ending-style:translate-x-full');
  });

  it('uses a compact width and padding', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const content = document.body.querySelector('[data-slot="drawer-content"]');
    expect(content).toHaveClass('w-[360px]');
    expect(content).toHaveClass('pr-0');
    expect(content).toHaveClass('pl-4');
    expect(content).toHaveClass('py-4');
    expect(content).toHaveClass('gap-2');
  });

  it('uses a drawer shadow that casts leftward', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const content = document.body.querySelector('[data-slot="drawer-content"]');
    expect(content).toHaveClass('shadow-[var(--shadow-drawer)]');
    expect(content).not.toHaveClass('shadow-[var(--shadow-dialog)]');
  });
});
