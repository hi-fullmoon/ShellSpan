import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LockIcon } from 'lucide-react';
import { ManagementCard, ManagementCardIcon } from '../management-card';

describe('ManagementCard', () => {
  it('keeps compact card density on the 10px padding grid', () => {
    const { container } = render(
      <ManagementCard>
        <ManagementCardIcon>
          <LockIcon />
        </ManagementCardIcon>
      </ManagementCard>,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveClass('p-2.5', 'gap-1.5');
    expect(card.querySelector('.size-8')).not.toBeNull();
    expect(card.querySelector('.size-9')).toBeNull();
  });
});
