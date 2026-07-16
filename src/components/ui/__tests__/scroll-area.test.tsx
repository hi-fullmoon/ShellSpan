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
  it('uses the shared square scrollbar thumb colors', () => {
    const { container } = render(
      <ScrollArea>
        <div>Content</div>
      </ScrollArea>,
    );

    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(thumb).toHaveClass('bg-border', 'hover:bg-muted-foreground');
    expect(thumb).not.toHaveClass('rounded-full');
  });
});
