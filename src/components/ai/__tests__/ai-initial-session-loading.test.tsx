import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { initI18n } from '@/locales';

beforeEach(async () => { await initI18n('en-US'); });
afterEach(cleanup);

it('keeps the composer at the bottom until automatic history discovery finishes', () => {
  const { container, rerender } = render(
    <AiWorkspaceRoot scope="workbench" view={null} restoringSession />,
  );
  const composer = container.querySelector('[data-slot="ai-composer-seat"]');
  expect(composer).toHaveAttribute('data-phase', 'active');
  expect(container.querySelector('[data-slot="ai-workspace-content"]')).toHaveAttribute('aria-busy', 'true');
  expect(container.querySelector('[data-slot="ai-workspace-body"]')).toHaveClass('min-h-0', 'flex-1');

  rerender(<AiWorkspaceRoot scope="workbench" view={null} restoringSession={false} />);
  expect(container.querySelector('[data-slot="ai-composer-seat"]')).toBe(composer);
  expect(composer).toHaveAttribute('data-phase', 'hero');
  expect(container.querySelector('[data-slot="ai-workspace-content"]')).not.toHaveAttribute('aria-busy');
});
