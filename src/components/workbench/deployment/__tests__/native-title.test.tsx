import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { t } from '@/locales';
import { DeploymentWorkflowTabs } from '../deployment-workflow-tabs';
import { WorkflowEditorToolbar } from '../workflow-editor-toolbar';

describe('Deployment native tooltips', () => {
  it('keeps accessible action labels without native title attributes', async () => {
    const { container } = render(
      <>
        <Tabs defaultValue="pipeline">
          <DeploymentWorkflowTabs
            activeTab="pipeline"
            loading={false} saving={false} validating={false} preparing={false}
            canCreate canSave canDeploy deployHint={null}
            onOpenWorkflows={() => undefined} onRefresh={() => undefined}
            onCreate={() => undefined} onSave={() => undefined}
            onValidate={() => undefined} onDeploy={() => undefined}
          />
        </Tabs>
        <WorkflowEditorToolbar
          workflowId={null} workflowName="" layout="compact" enabled editable
          issueCount={0} dirty={false}
          onOpenIssues={() => undefined} onOpenLibrary={() => undefined}
          onOpenInspector={() => undefined} onOpenSettings={() => undefined}
        />
      </>,
    );
    await waitFor(() => {
      expect(container.querySelector('[title]')).toBeNull();
      const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        t('deployment.editor.tab.pipeline'),
        t('deployment.editor.tab.runs'),
        t('deployment.editor.tab.versions'),
      ]);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      const actions = container.querySelectorAll('button[aria-label]');
      expect(actions.length).toBeGreaterThanOrEqual(9);
      for (const action of actions) expect(action).toHaveAccessibleName();
    });
  });
});
