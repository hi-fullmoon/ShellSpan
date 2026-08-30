import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkbenchPageContent } from '../workbench-page';

describe('WorkbenchPageContent', () => {
  it('fills the available workbench width by default', () => {
    const { getByRole } = render(
      <WorkbenchPageContent>Content</WorkbenchPageContent>,
    );

    const content = getByRole('main');
    expect(content).toHaveClass('w-full');
    expect(content).not.toHaveClass('max-w-screen-2xl');
  });

  it('allows individual pages to opt into a narrower content width', () => {
    const { getByRole } = render(
      <WorkbenchPageContent className="max-w-4xl">Content</WorkbenchPageContent>,
    );

    expect(getByRole('main')).toHaveClass('mx-auto', 'max-w-4xl');
  });
});
