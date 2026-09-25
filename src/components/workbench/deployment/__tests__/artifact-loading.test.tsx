import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, t } from '@/locales';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { ArtifactDrawer } from '../artifact-drawer';

beforeEach(async () => {
  await initI18n('zh-CN');
  useDeploymentWorkflowRunStore.getState().reset();
});
afterEach(() => {
  cleanup();
  useDeploymentWorkflowRunStore.getState().reset();
});

describe('artifact inspection loading', () => {
  it('opens before an artifact is available and allows keyboard dismissal', async () => {
    render(<ArtifactDrawer />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useDeploymentWorkflowRunStore.setState({ action: 'artifact' }));
    const drawer = await screen.findByRole('dialog');
    expect(screen.getByText(t('common.loading'))).toBeVisible();
    expect(drawer.querySelector('[data-slot="scroll-area"]')?.className).toContain('min-h-0');
    const footer = drawer.querySelector('[data-slot="drawer-footer"]');
    expect(footer?.className).toContain('shrink-0');
    expect(footer?.className).not.toContain('border-t');
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useDeploymentWorkflowRunStore.getState().action).toBeNull();
  });

  it('closes on failure and leaves the error for the existing toast handler', async () => {
    useDeploymentWorkflowRunStore.setState({ action: 'artifact' });
    render(<ArtifactDrawer />);
    expect(await screen.findByRole('dialog')).toBeVisible();
    act(() => useDeploymentWorkflowRunStore.setState({
      action: null, error: 'DEPLOYMENT_ARTIFACT_NOT_FOUND', errorContext: 'operation',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useDeploymentWorkflowRunStore.getState().error).toBe('DEPLOYMENT_ARTIFACT_NOT_FOUND');
  });

  it('does not clear a different operation when closing an artifact', () => {
    useDeploymentWorkflowRunStore.setState({ action: 'cancel' });
    useDeploymentWorkflowRunStore.getState().clearArtifact();
    expect(useDeploymentWorkflowRunStore.getState().action).toBe('cancel');
  });
});
