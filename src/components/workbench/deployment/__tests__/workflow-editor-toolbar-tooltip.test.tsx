import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { WorkflowEditorToolbar } from '../workflow-editor-toolbar';

afterEach(cleanup);

describe('workflow toolbar tooltips', () => {
  it.each(['zh-CN', 'en-US'] as const)('shows translated hints on hover and keyboard focus in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={0}>
        <WorkflowEditorToolbar
          workflowId="workflow"
          workflowName=""
          layout="compact"
          enabled
          editable
          issueCount={0}
          dirty={false}
          onOpenIssues={() => undefined}
          onOpenInspector={() => undefined}
          onOpenSettings={() => undefined}
        />
      </TooltipProvider>,
    );

    for (const key of [
      'deployment.editor.settings',
      'deployment.editor.configuration',
      'deployment.editor.delete.title',
    ] as const) {
      const button = screen.getByRole('button', { name: t(key) });
      expect(button).toHaveClass('size-8');
      expect(button).not.toHaveAttribute('title');
      await user.hover(button);
      expect(await screen.findByText(t(key))).toBeVisible();
      await user.unhover(button);
      await waitFor(() => expect(screen.queryByText(t(key))).not.toBeInTheDocument());
    }

    await user.tab(); // Validation status.
    for (const key of [
      'deployment.editor.settings',
      'deployment.editor.configuration',
      'deployment.editor.delete.title',
    ] as const) {
      await user.tab();
      expect(screen.getByRole('button', { name: t(key) })).toHaveFocus();
      expect(await screen.findByText(t(key))).toBeVisible();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText(t(key))).not.toBeInTheDocument());
    }
  });
});
