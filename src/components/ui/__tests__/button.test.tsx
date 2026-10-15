import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadIcon } from 'lucide-react';
import { Button } from '../button';
import { Spinner } from '../empty-state';
import { InputGroupButton } from '../input-group';
import { Toggle } from '../toggle';

describe('Button', () => {
  it('pairs small text and icon actions with matching dimensions and keyboard access', async () => {
    render(<>
      <Button size="sm"><DownloadIcon />Export</Button>
      <Button size="icon-sm" aria-label="Download"><DownloadIcon /></Button>
    </>);
    const text = screen.getByRole('button', { name: 'Export' });
    const icon = screen.getByRole('button', { name: 'Download' });
    expect(text).toHaveClass('h-8', 'px-2.5', 'text-xs', 'gap-1');
    expect(icon).toHaveClass('size-8');
    for (const button of [text, icon]) expect(button.className).toContain('[&_svg]:size-3.5');
    await userEvent.tab();
    expect(text).toHaveFocus();
    await userEvent.tab();
    expect(icon).toHaveFocus();
  });

  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /Click me/i })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('optically aligns inline icons with button text', () => {
    render(
      <Button variant="outline" size="sm">
        <DownloadIcon data-icon="inline-start" />
        Export
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).toHaveClass('leading-none');
    expect(button).toHaveClass('gap-1');
    expect(button.className).toContain('[&_svg]:size-3.5');
  });

  it('provides compact square sizes for icon-only actions', () => {
    render(
      <Button size="icon-xs" aria-label="Download">
        <DownloadIcon />
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Download' });
    expect(button).toHaveClass('size-6');
    expect(button.className).toContain('[&_svg]:size-3');
  });

  it('uses the same icon and label spacing in input actions and toggles', () => {
    render(
      <>
        <InputGroupButton><DownloadIcon data-icon="inline-start" />Export</InputGroupButton>
        <Toggle><DownloadIcon data-icon="inline-start" />Export selected</Toggle>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Export' })).toHaveClass('gap-1');
    expect(screen.getByRole('button', { name: 'Export selected' })).toHaveClass('gap-1');
  });

  it('renders destructive outline actions without a filled background', () => {
    render(<Button variant="destructiveOutline">Delete</Button>);

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('border-destructive', 'bg-transparent', 'text-destructive', 'hover:bg-transparent');
    expect(button).not.toHaveClass('bg-destructive');
  });

  it('lets loading indicators inherit the button foreground color', () => {
    const { container } = render(
      <Button disabled>
        <Spinner data-icon="inline-start" />
        Loading
      </Button>,
    );

    const spinner = container.querySelector('svg.animate-spin');
    expect(spinner).not.toHaveClass('text-muted-foreground');
    expect(spinner).toHaveAttribute('data-icon', 'inline-start');
  });
});
