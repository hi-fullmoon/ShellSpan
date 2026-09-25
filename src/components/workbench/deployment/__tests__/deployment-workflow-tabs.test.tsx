import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { DeploymentWorkflowTab } from '@/stores/deploymentWorkflowStore';
import { DeploymentWorkflowTabs } from '../deployment-workflow-tabs';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import release from '../../../../../docs/design/deployment-center-product-phase-3-evidence.json';

describe('Deployment tab action context', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    useDeploymentWorkflowRunStore.getState().reset();
  });

  it('places preparation cancellation immediately beside deploy and waits for the run ID', () => {
    function View(): React.JSX.Element {
      const preparing = useDeploymentWorkflowRunStore((state) => state.preparing);
      return <Tabs value="runs"><DeploymentWorkflowTabs activeTab="runs" loading={false} saving={false} validating={false}
        preparing={preparing} canCreate canSave canDeploy deployHint={null}
        onOpenWorkflows={() => undefined} onRefresh={() => undefined} onCreate={() => undefined}
        onSave={() => undefined} onValidate={() => undefined} onDeploy={() => undefined} /></Tabs>;
    }
    render(<View />);
    expect(screen.queryByRole('button', { name: t('deployment.runtime.cancel.action') })).toBeNull();
    act(() => useDeploymentWorkflowRunStore.setState({ preparing: true }));
    const cancel = screen.getByRole('button', { name: t('deployment.runtime.cancel.action') });
    const deploy = screen.getByTestId('deployment-deploy-action');
    expect(cancel.nextElementSibling).toBe(deploy);
    expect(cancel.parentElement).toBe(screen.getByTestId('deployment-workflow-actions'));
    expect(cancel).toBeDisabled();
    expect(deploy).toBeDisabled();
    act(() => useDeploymentWorkflowRunStore.setState({ preparationRunId: release.detail.summary.runId }));
    expect(cancel).toBeEnabled();
    act(() => useDeploymentWorkflowRunStore.setState({ preparing: false }));
    expect(screen.queryByRole('button', { name: t('deployment.runtime.cancel.action') })).toBeNull();
  });

  it('keeps editing actions in the pipeline and preserves deployment access across tabs', async () => {
    const actions: string[] = [];
    function View(): React.JSX.Element {
      const [tab, setTab] = React.useState<DeploymentWorkflowTab>('pipeline');
      return <Tabs value={tab} onValueChange={(value) => setTab(value as DeploymentWorkflowTab)}>
        <DeploymentWorkflowTabs activeTab={tab}
          loading={false} saving={false} validating={false} preparing={false}
          canCreate canSave canDeploy deployHint={null}
          onOpenWorkflows={() => actions.push('workflows')}
          onRefresh={() => actions.push(`refresh:${tab}`)}
          onCreate={() => actions.push('create')} onSave={() => actions.push('save')}
          onValidate={() => actions.push('validate')} onDeploy={() => actions.push('deploy')} />
      </Tabs>;
    }
    render(<View />);
    for (const name of ['deployment.editor.newWorkflow', 'common.save', 'deployment.editor.validate'] as const) {
      expect(screen.getByRole('button', { name: t(name) })).toBeEnabled();
    }
    for (const key of ['deployment.editor.tab.runs', 'deployment.editor.tab.versions'] as const) {
      fireEvent.click(screen.getByRole('tab', { name: t(key) }));
      await waitFor(() => expect(screen.getByRole('tab', { name: t(key) })).toHaveAttribute('aria-selected', 'true'));
      for (const name of ['deployment.editor.newWorkflow', 'common.save', 'deployment.editor.validate'] as const) {
        expect(screen.queryByRole('button', { name: t(name) })).not.toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole('button', { name: t('common.refresh') }));
      expect(screen.getByRole('button', { name: t('deployment.editor.workflows') })).toBeEnabled();
      expect(screen.getByRole('button', { name: t('deployment.runtime.deploy.action') })).toBeEnabled();
    }
    expect(actions).toEqual(['refresh:runs', 'refresh:versions']);
    expect(screen.getByRole('tab', { name: '发布版本' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: t('deployment.editor.tab.pipeline') }));
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    expect(actions[actions.length - 1]).toBe('save');
  });
});
