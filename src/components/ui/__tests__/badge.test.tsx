import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';

describe('Badge', () => {
  it('uses leading-none across sizes so badge text stays vertically centered without overflowing', () => {
    render(
      <>
        <Badge data-testid="badge-default">Modified</Badge>
        <Badge data-testid="badge-sm" size="sm">已修改</Badge>
      </>,
    );

    const defaultBadge = screen.getByTestId('badge-default');
    const smBadge = screen.getByTestId('badge-sm');

    expect(defaultBadge).toHaveClass('h-5', 'text-xs', 'leading-none');
    expect(defaultBadge).not.toHaveClass('py-0.5');
    expect(smBadge).toHaveClass('h-4', 'text-[10px]', 'leading-none');
  });
});
