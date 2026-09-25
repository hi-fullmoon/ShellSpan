import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import evidence from '../../../../../docs/design/deployment-center-product-phase-3-evidence.json';
import type { DeploymentRunDetail, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import type { DeploymentApplicationEntry, DeploymentReadinessReport } from '@/lib/deployment/applications';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { t } from '@/locales';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';
import { ApplicationRelease, ServiceObservation } from '../application-release';
import { ApprovalDialog } from '../approval-dialog';

// Recorded native Git / SQLite / SSH / SFTP / Compose results. Rendering these
// projections needs neither a simulated IPC layer nor fabricated remote state.
const detail = evidence.detail as unknown as DeploymentRunDetail;
const workflow = evidence.workflow as unknown as DeploymentWorkflowRecord;
const entry = evidence.entry as DeploymentApplicationEntry;
const initial = useDeploymentWorkflowRunStore.getState();
afterEach(() => { cleanup(); useDeploymentWorkflowRunStore.setState(initial, true); });

describe('Application release projections', () => {
  it('keeps a dated server check separate from continuous online status', async () => {
    render(<ServiceObservation detail={detail} />);
    expect(await screen.findByText(t('deployment.release.observedPassed'))).toBeVisible();
    expect(screen.getByText(t('deployment.release.observationHelp'))).toBeVisible();
    expect(screen.getByText(t('deployment.release.releaseChecks'))).toBeVisible();
    expect(detail.serviceObservation?.status).toBe('passed');
    expect(detail.summary.status).toBe('succeeded');
  });

  it('shows unknown when no current-release observation exists', async () => {
    render(<ServiceObservation detail={null} />);
    expect(await screen.findByText(t('deployment.release.unknown'))).toBeVisible();
    expect(screen.queryByText(t('deployment.release.observedPassed'))).toBeNull();
  });

  it('shows frozen host and verification scope, and cannot execute a completed run again', async () => {
    useDeploymentWorkflowRunStore.setState({ workflowId: workflow.id, detail });
    render(<ApprovalDialog open onOpenChange={() => undefined} workflow={workflow} />);
    const dialog = await screen.findByTestId('deployment-approval-dialog');
    expect(screen.getByText('shellspan@127.0.0.1:22224')).toBeVisible();
    expect(screen.getByText('http://127.0.0.1:3000/for-you/')).toBeVisible();
    expect(screen.getByRole('button', { name: t('deployment.runtime.approveAndRun') })).toBeDisabled();
    expect(dialog.querySelector('[data-slot="scroll-area"]')?.className).toContain('min-h-0');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(footer?.className).toContain('shrink-0');
    expect(footer?.className).not.toContain('border-t');
    await waitFor(() => expect(screen.getByRole('button', { name: t('common.cancel') })).toHaveFocus());
  });

  it('opens release history without a canvas and restores keyboard focus to its trigger', async () => {
    useDeploymentWorkflowRunStore.setState({ workflowId: workflow.id, detail, runs: [detail.summary], loading: false });
    render(<ApplicationRelease entry={entry} workflow={workflow} report={evidence.readiness as DeploymentReadinessReport} onReport={() => undefined} admissionsEnabled />);
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: t('deployment.release.runs') });
    await user.click(trigger);
    const dialog = await screen.findByTestId('deployment-release-detail');
    expect(dialog.className).toContain('100dvh');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')?.className).not.toContain('border-t');
    expect(dialog.querySelector('canvas')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: t('common.close') })[0]!);
    await waitFor(() => expect(screen.queryByTestId('deployment-release-detail')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('provides both languages for release observations and guard events', () => {
    expect(Object.keys(en).filter((key) => key.startsWith('deployment.release.')).sort())
      .toEqual(Object.keys(zh).filter((key) => key.startsWith('deployment.release.')).sort());
    expect(zh['deployment.service.observed']).toBeTruthy();
    expect(en['deployment.run.preStartRejected']).toBeTruthy();
  });
});
