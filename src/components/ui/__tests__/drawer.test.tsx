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

    expect(content).toHaveClass('transition-opacity');
    expect(content).toHaveClass('duration-150');
    expect(content).toHaveClass('data-starting-style:opacity-0');
    expect(content).toHaveClass('data-ending-style:opacity-0');
    expect(content).not.toHaveClass(
      'transition-transform',
      'data-starting-style:translate-x-full',
      'data-ending-style:translate-x-full',
    );
  });

  it('uses a compact width and padding', () => {
    render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const content = document.body.querySelector('[data-slot="drawer-content"]');
    expect(content).toHaveClass('w-[360px]');
    expect(content).toHaveClass('p-4');
    expect(content).toHaveClass('gap-2');
  });

  it('anchors the close button to the drawer padding by default and lets callers align it with their header', () => {
    const { unmount } = render(
      <Drawer open={true}>
        <DrawerContent>Content</DrawerContent>
      </Drawer>,
    );

    const closeButton = document.body.querySelector('[data-slot="drawer-close"]');
    expect(closeButton).toHaveClass('absolute', 'top-4', 'right-4');
    expect(closeButton).toHaveClass('h-9', 'w-9');
    expect(closeButton).not.toHaveClass('size-8');

    unmount();
    render(
      <Drawer open={true}>
        <DrawerContent closeButtonClassName="top-2 right-3 size-8">
          Content
        </DrawerContent>
      </Drawer>,
    );

    const alignedCloseButton = document.body.querySelector('[data-slot="drawer-close"]');
    expect(alignedCloseButton).toHaveClass('absolute', 'top-2', 'right-3');
    expect(alignedCloseButton).toHaveClass('size-8');
    expect(alignedCloseButton).not.toHaveClass('top-4', 'right-4', 'h-9', 'w-9');
  });
});
