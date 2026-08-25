import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../card';

describe('Card', () => {
  it('keeps the footer on the same surface as the card body', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Server status</CardTitle>
        </CardHeader>
        <CardContent>Healthy</CardContent>
        <CardFooter>Updated now</CardFooter>
      </Card>,
    );

    const footer = screen.getByText('Updated now');
    expect(footer).toHaveAttribute('data-slot', 'card-footer');
    expect(footer).toHaveClass('border-t');
    expect(footer.className.split(/\s+/)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^bg-/)]),
    );
  });

  it('offers an outline surface without the dark foreground ring', () => {
    render(<Card variant="outline">Outlined content</Card>);

    const card = screen.getByText('Outlined content');
    expect(card).toHaveAttribute('data-variant', 'outline');
    expect(card).toHaveClass('border', 'border-border');
    expect(card).not.toHaveClass('ring-1', 'ring-foreground/10');
  });
});
