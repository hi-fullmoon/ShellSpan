import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import release from '../../../../../docs/design/deployment-center-product-phase-3-evidence.json';
import type { DeploymentRunSummary, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { initI18n, t } from '@/locales';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useAppStore } from '@/stores/appStore';
import { DeploymentWorkflowRuntimeView } from '../../deployment-workflow-runtime';

beforeEach(async () => {
  useAppStore.setState({ locale: 'zh-CN' });
  await initI18n('zh-CN');
  useDeploymentWorkflowRunStore.getState().reset();
});
afterEach(() => {
  cleanup();
  useDeploymentWorkflowRunStore.getState().reset();
});

it('shows preparation without duplicating the toolbar cancellation action', () => {
  useDeploymentWorkflowRunStore.setState({ preparing: true });
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord} canDeploy />);
  expect(screen.getByTestId('deployment-preparing-progress')).toBeVisible();
  expect(screen.queryByText(t('deployment.runtime.runs.empty'))).toBeNull();
  expect(screen.queryByRole('button', { name: t('deployment.runtime.cancel.action') })).toBeNull();
  expect(screen.getByTestId('deployment-preparation-view')).toHaveClass('min-h-0', 'flex-1');
  act(() => useDeploymentWorkflowRunStore.setState({ preparing: false }));
  expect(screen.queryByTestId('deployment-preparing-progress')).toBeNull();
  expect(screen.getByText(t('deployment.runtime.runs.empty'))).toBeVisible();
});

it('shows preparation errors without a run and replaces them when retrying', () => {
  const reason = t('deployment.runtime.capability.description');
  useDeploymentWorkflowRunStore.setState({ error: reason, errorContext: 'prepare' });
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord} canDeploy />);
  expect(screen.getByTestId('deployment-prepare-error')).toHaveTextContent(reason);
  expect(screen.queryByRole('button', { name: t('deployment.runtime.deploy.action') })).toBeNull();
  expect(screen.queryByText(t('deployment.runtime.runs.empty'))).toBeNull();
  act(() => useDeploymentWorkflowRunStore.setState({ preparing: true, error: null, errorContext: null }));
  expect(screen.queryByTestId('deployment-prepare-error')).toBeNull();
  expect(screen.getByTestId('deployment-preparing-progress')).toBeVisible();
});

it('shows preparation when a previous run exists but its detail is not loaded', () => {
  useDeploymentWorkflowRunStore.setState({
    runs: [release.detail.summary as unknown as DeploymentRunSummary],
    preparing: true,
    loading: true,
  });
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord} />);
  expect(screen.getByTestId('deployment-preparing-progress')).toBeVisible();
  expect(screen.queryByTestId('deployment-runs-view')).toBeNull();
});

it.each(['zh-CN', 'en-US'] as const)('explains managed-field conflicts and opens configuration in %s', async (locale) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  useDeploymentWorkflowRunStore.setState({ error: 'DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED', errorContext: 'prepare' });
  let trigger: HTMLButtonElement | null = null;
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord}
    onOpenDeploymentChecks={(element) => { trigger = element; }} />);
  const alert = screen.getByTestId('deployment-prepare-error');
  expect(alert).toHaveTextContent(t('deployment.runtime.managedFieldsChanged.description'));
  expect(alert).not.toHaveTextContent('DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED');
  const button = screen.getByRole('button', { name: t('deployment.application.configure') });
  await userEvent.setup().click(button);
  expect(trigger).toBe(button);
});

it.each(['zh-CN', 'en-US'] as const)('explains revision conflicts without exposing backend codes in %s', async (locale) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord} />);
  for (const error of ['DEPLOYMENT_APPLICATION_REVISION_CONFLICT', 'DEPLOYMENT_WORKFLOW_REVISION_CONFLICT']) {
    act(() => useDeploymentWorkflowRunStore.setState({ error, errorContext: 'prepare' }));
    const alert = screen.getByTestId('deployment-prepare-error');
    expect(alert).toHaveTextContent(t('deployment.runtime.revisionConflict.title'));
    expect(alert).toHaveTextContent(t('deployment.runtime.revisionConflict.description'));
    expect(alert).not.toHaveTextContent(error);
  }
});

it.each(['zh-CN', 'en-US'] as const)('explains readiness failures and opens checks from the alert in %s', async (locale) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  useDeploymentWorkflowRunStore.setState({ error: 'DEPLOYMENT_APPLICATION_READINESS_REQUIRED', errorContext: 'prepare' });
  let trigger: HTMLButtonElement | null = null;
  render(<DeploymentWorkflowRuntimeView kind="runs" workflow={release.workflow as unknown as DeploymentWorkflowRecord}
    onOpenDeploymentChecks={(element) => { trigger = element; }} />);
  const alert = screen.getByTestId('deployment-prepare-error');
  expect(alert).toHaveTextContent(t('deployment.runtime.readinessRequired.description'));
  expect(alert).not.toHaveTextContent('DEPLOYMENT_APPLICATION_READINESS_REQUIRED');
  expect(screen.queryByRole('button', { name: t('deployment.runtime.deploy.action') })).toBeNull();
  const button = screen.getByRole('button', { name: t('deployment.runtime.readinessRequired.action') });
  expect(alert).toContainElement(button);
  await userEvent.setup().click(button);
  expect(trigger).toBe(button);
});
