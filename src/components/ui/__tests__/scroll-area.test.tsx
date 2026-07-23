import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ScrollArea } from '../scroll-area';

vi.mock('@base-ui/react/scroll-area', () => {
  type PrimitiveProps = ComponentProps<'div'> & { orientation?: string };
  const Primitive = ({ orientation: _orientation, ...props }: PrimitiveProps) => (
    <div {...props} />
  );

  return {
    ScrollArea: {
      Root: Primitive,
      Viewport: Primitive,
      Scrollbar: Primitive,
      Thumb: Primitive,
      Corner: Primitive,
    },
  };
});

describe('ScrollArea', () => {
  it('uses the shared scrollbar thumb colors and square style', () => {
    const { container } = render(
      <ScrollArea>
        <div>Content</div>
      </ScrollArea>,
    );

    const scrollbar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(scrollbar).toHaveClass('w-2');
    expect(thumb).toHaveClass('bg-app-border', 'hover:bg-app-text-soft/60');
    expect(thumb).not.toHaveClass('rounded-full');
    expect(thumb).not.toHaveClass('flex-1');
  });

  it('supports a thin hover-reveal scrollbar variant', () => {
    const { container } = render(
      <ScrollArea size="thin" horizontal>
        <div>Content</div>
      </ScrollArea>,
    );

    const scrollbar = container.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]');
    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(scrollbar).toHaveClass('h-1', 'bg-transparent');
    expect(thumb).toHaveClass('bg-transparent', 'group-hover/scroll-area:bg-app-text-soft/35');
  });
});
