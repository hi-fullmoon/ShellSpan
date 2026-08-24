import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Trash2Icon } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconActionButton } from '../icon-action-button';

describe('IconActionButton', () => {
  it('shows its action label in a tooltip', async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <IconActionButton
          aria-label="Delete"
          tooltip="Delete"
          className="size-7"
        >
          <Trash2Icon data-icon="inline-start" />
        </IconActionButton>
      </TooltipProvider>,
    );

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('size-8');
    expect(button).not.toHaveClass('size-7');

    await user.hover(button);

    expect(await screen.findByText('Delete')).toHaveAttribute(
      'data-slot',
      'tooltip-content',
    );
  });

  it('shows the tooltip while the action is disabled', async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <IconActionButton aria-label="Delete" tooltip="Delete" disabled>
          <Trash2Icon data-icon="inline-start" />
        </IconActionButton>
      </TooltipProvider>,
    );

    await user.hover(screen.getByLabelText('Delete', { selector: 'span' }));

    expect(await screen.findByText('Delete')).toHaveAttribute(
      'data-slot',
      'tooltip-content',
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});
