import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../select';

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

  it('matches the small button height', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger data-testid="trigger" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByTestId('trigger')).toHaveClass('data-[size=sm]:h-8');
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

describe('overflow handling', () => {
  const longLabel = '175.178.66.45 · root@175.178.66.45 · /srv/apps/example';

  it('ellipsizes the selected value instead of hard-clipping it', () => {
    render(
      <Select defaultValue="target" items={[{ value: 'target', label: longLabel }]}>
        <SelectTrigger data-testid="trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="target">{longLabel}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByTestId('trigger');
    const value = trigger.querySelector('[data-slot="select-value"]');
    expect(value).not.toBeNull();
    expect(value).toHaveClass('min-w-0', 'flex-1', 'truncate');
    // A flex or line-clamp display forced onto the value defeats the ellipsis in WebKit.
    expect(trigger.className).not.toMatch(/\*:[^\s]*select-value[^\s]*:(flex|line-clamp-1)/);
  });

  it('ellipsizes option labels that exceed the popup width', () => {
    render(
      <Select defaultValue="target" items={[{ value: 'target', label: longLabel }]}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="target">{longLabel}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const itemText = screen.getByText(longLabel);
    expect(itemText).toHaveClass('min-w-0', 'flex-1', 'truncate');
    expect(itemText).not.toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  it('sizes the popup between the trigger width and the available width', () => {
    render(
      <Select open onOpenChange={() => {}} defaultValue="target" items={[{ value: 'target', label: longLabel }]}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="target">{longLabel}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const content = document.querySelector('[data-slot="select-content"]');
    expect(content).not.toBeNull();
    expect(content).toHaveClass('max-w-(--available-width)');
    expect(content).toHaveClass('min-w-[max(var(--anchor-width),9rem)]');
    expect(content).not.toHaveClass('w-(--anchor-width)');
  });
});
