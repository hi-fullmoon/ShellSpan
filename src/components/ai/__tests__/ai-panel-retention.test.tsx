import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiPanelShell } from '../ai-panel';
import { WorkbenchAskController } from '../workspace/ai-workspace-controller';
import { initI18n } from '@/locales';
import userEvent from '@/test/composer-editor-user';

beforeEach(async () => { await initI18n('en-US'); });
afterEach(cleanup);

it('lazily mounts the workbench and retains its controller and draft across closes', async () => {
  const panel = (open: boolean) => (
    <AiPanelShell open={open} visible panelTitle="AI" scope="workbench" onOpenChange={() => {}}>
      <WorkbenchAskController />
    </AiPanelShell>
  );
  const { container, rerender } = render(panel(false));
  expect(container.querySelector('[data-slot="ai-workspace-root"]')).toBeNull();
  rerender(panel(true));
  const workspace = container.querySelector('[data-slot="ai-workspace-root"]');
  const editor = screen.getByRole('textbox');
  await userEvent.setup().type(editor, 'Keep this draft');
  for (let visit = 0; visit < 3; visit += 1) {
    rerender(panel(false));
    expect(container.querySelector('[data-slot="ai-workspace-root"]')).toBe(workspace);
    expect(container.querySelector('[data-slot="ai-panel"]')).toHaveAttribute('hidden');
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(panel(true));
    expect(screen.getByRole('textbox')).toBe(editor);
    expect(editor).toHaveTextContent('Keep this draft');
  }
});
