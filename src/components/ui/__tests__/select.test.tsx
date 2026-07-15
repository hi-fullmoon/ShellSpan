import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('SelectTrigger', () => {
  it('matches input height and fills its container', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger data-testid="trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByTestId('trigger');
    expect(trigger).toHaveClass('data-[size=default]:h-9');
    expect(trigger).toHaveClass('w-full');
    expect(trigger).toHaveClass('px-3');
    expect(trigger).toHaveClass('py-1');
  });

  it('uses a single focus ring', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger data-testid="trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByTestId('trigger');
    expect(trigger).toHaveClass('focus-visible:ring-1');
    expect(trigger).not.toHaveClass('focus-visible:ring-3');
    expect(trigger).toHaveClass('aria-invalid:ring-1');
    expect(trigger).not.toHaveClass('aria-invalid:ring-3');
  });
});
