import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { buildDeploymentTemplate } from '@/lib/deployment/editor';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { WorkflowEditorToolbar } from '../workflow-editor-toolbar';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values?.name ? `${key}:${values.name}` : key
    ),
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeArchiveDeploymentWorkflow: vi.fn().mockResolvedValue(undefined),
}));

function record(id: string, name: string): DeploymentWorkflowRecord {
  const { definition, layout } = buildDeploymentTemplate(
    'staticSite',
    { connectionProfileId: 'profile-1', remoteRoot: '/srv/example' },
    (type) => type,
  );
  return {
    id, name, enabled: true, archived: false,
    revision: 2, definitionDigest: `sha256:${'a'.repeat(64)}`, definition,
    layoutRevision: 1, layout, createdAt: 1, updatedAt: 2,
  };
}

const current = record('workflow-1', 'Website');
const other = record('workflow-2', 'Other site');

function renderToolbar(dirty = false, layout: 'wide' | 'compact' = 'wide'): void {
  render(
    <WorkflowEditorToolbar
      workflowId={current.id}
      workflowName={current.name}
      layout={layout}
      enabled={current.enabled}
      editable
      issueCount={0}
      dirty={dirty}
      onOpenIssues={() => undefined}
      onOpenInspector={() => undefined}
      onOpenSettings={() => undefined}
    />,
  );
}

describe('WorkflowEditorToolbar delete entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeploymentWorkflowStore.getState().reset();
    useDeploymentWorkflowRunStore.getState().reset();
    useDeploymentWorkflowStore.setState({
      catalog: null,
      workflows: [current, other],
      selectedWorkflowId: current.id,
      selectedNodeId: null,
      draft: {
        id: current.id, name: current.name, enabled: current.enabled,
        revision: current.revision, layoutRevision: current.layoutRevision,
        definition: structuredClone(current.definition),
        layout: structuredClone(current.layout!),
      },
      initialized: true,
    });
  });

  it('confirms with the workflow name and archives it on approval', async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('deployment-delete-workflow'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('deployment.editor.delete.description:Website');

    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.delete.action' }));
    await waitFor(() => expect(
      useDeploymentWorkflowStore.getState().workflows.map((item) => item.id),
    ).toEqual([other.id]));
    expect(useDeploymentWorkflowStore.getState().draft).toBeNull();
  });

  it('discloses that unsaved changes are discarded for a dirty draft', async () => {
    renderToolbar(true);
    fireEvent.click(screen.getByTestId('deployment-delete-workflow'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('deployment.editor.delete.dirtyDescription:Website');
    expect(dialog).not.toHaveTextContent('deployment.editor.delete.description:Website');

    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.delete.action' }));
    await waitFor(() => expect(useDeploymentWorkflowStore.getState().draft).toBeNull());
  });

  it('is disabled while a deployment run is being prepared or approved', () => {
    useDeploymentWorkflowRunStore.setState({ preparing: true });
    renderToolbar();
    expect(screen.getByTestId('deployment-delete-workflow')).toBeDisabled();
  });
});

describe('WorkflowEditorToolbar header actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeploymentWorkflowStore.getState().reset();
    useDeploymentWorkflowRunStore.getState().reset();
    useDeploymentWorkflowStore.setState({ catalog: null, initialized: true });
  });

  it('renders borderless icon buttons in both layouts', () => {
    for (const layout of ['wide', 'compact'] as const) {
      renderToolbar(false, layout);
      expect(screen.queryByRole('button', { name: 'deployment.editor.nodeLibrary' })).not.toBeInTheDocument();
      const labels = [
        'deployment.editor.settings',
        'deployment.editor.configuration',
        'deployment.editor.delete.title',
      ];
      for (const label of labels) {
        const button = screen.queryByRole('button', { name: label });
        // The inspector button only exists outside the wide layout.
        if (!button && label === 'deployment.editor.configuration' && layout === 'wide') continue;
        expect(button, `${layout}:${label}`).not.toBeNull();
        expect(button, `${layout}:${label} must stay borderless (ghost)`).not.toHaveClass('border');
      }
      cleanup();
    }
  });
});
