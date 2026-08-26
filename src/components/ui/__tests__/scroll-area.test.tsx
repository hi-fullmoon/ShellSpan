import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ScrollArea, ScrollAreaContent } from '../scroll-area';

vi.mock('@base-ui/react/scroll-area', () => {
  type PrimitiveProps = ComponentProps<'div'> & { orientation?: string };
  const Primitive = ({ orientation: _orientation, ...props }: PrimitiveProps) => (
    <div {...props} />
  );

  return {
    ScrollArea: {
      Root: Primitive,
      Viewport: Primitive,
      Content: Primitive,
      Scrollbar: Primitive,
      Thumb: Primitive,
      Corner: Primitive,
    },
  };
});

describe('ScrollArea', () => {
  it('uses the shared inset rounded scrollbar style', () => {
    const { container } = render(
      <ScrollArea>
        <div>Content</div>
      </ScrollArea>,
    );

    const scrollbar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(scrollbar).toHaveClass('w-2.5', 'p-0.5');
    expect(thumb).toHaveClass('rounded-full', 'bg-app-text-soft/30', 'hover:bg-app-text-soft/50');
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

  it('exposes the observed content container for dynamically sized content', () => {
    const { container } = render(
      <ScrollArea>
        <ScrollAreaContent className="flex flex-col gap-3">
          <div>Content</div>
        </ScrollAreaContent>
      </ScrollArea>,
    );

    expect(container.querySelector('[data-slot="scroll-area-content"]'))
      .toHaveClass('flex', 'flex-col', 'gap-3');
  });
});
