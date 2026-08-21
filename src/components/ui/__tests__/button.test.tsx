import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadIcon } from 'lucide-react';
import { Button } from '../button';

describe('Button', () => {
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
    expect(button.className).toContain('[&_svg]:size-3.5');
  });
});
