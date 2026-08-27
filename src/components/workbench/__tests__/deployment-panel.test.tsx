import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentPanel } from '../deployment-panel';
import { useProfileStore } from '@/stores/profileStore';
import * as tauri from '@/lib/tauri';
import { createDeploymentTemplate } from '@/lib/deployment-workflow';
import { serializeDeploymentRunbookV2 } from '@/lib/deployment-runbook';
import type { ConnectionProfile } from '@/types';
import type {
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewV2,
} from '@/types/deployment-runbook';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

const originalEnsurePassword = useProfileStore.getState().ensurePassword;

const profile: ConnectionProfile = {
  id: 'prod-a',
  name: 'Production A',
  host: 'prod-a.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'key',
  password: 'must-not-render-or-persist',
  createdAt: 1,
  updatedAt: 1,
};

function validDocumentText(): string {
  const draft = createDeploymentTemplate('singleSystemdWeb');
  const document = draft.document;
  document.id = 'acme-web-production';
  document.name = 'Deploy Acme Web';
  document.deployment.applicationId = 'acme-web';
  document.deployment.version = '1.2.3';
  document.deployment.id = 'acme-web-1.2.3';
  document.artifacts[0]!.description = 'Verified Acme Web release archive.';
  document.artifacts[0]!.sourceUri = 'file:///opt/termbridge-artifacts/acme-web.tar.gz';
  document.artifacts[0]!.sha256 = 'a'.repeat(64);
  document.artifacts[0]!.targetPath = 'artifacts/acme-web.tar.gz';
  document.release.rootDirectory = '/srv/acme-web';
  document.release.releasesDirectory = '/srv/acme-web/releases';
  document.release.releaseDirectory = '/srv/acme-web/releases/acme-web-1.2.3';
  document.release.activeSymlink = '/srv/acme-web/current';
  document.services[0]!.unit = 'acme-web.service';
  return serializeDeploymentRunbookV2(document);
}

function review(runbookText: string): DeploymentExecutionReviewV2 {
  return {
    schemaVersion: 2,
    reviewId: 'deployment-review:component',
    operationId: 'deployment:component',
    normalizedRunbookText: runbookText,
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:plan',
    deploymentId: 'acme-web-1.2.3',
    applicationId: 'acme-web',
    environment: 'production',
    version: '1.2.3',
    artifactDigests: [],
    declaredRisk: 'stateChange',
    target: {
      profileId: profile.id,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod,
      identityDigest: 'sha256-v1:target',
    },
    policy: {
      artifactTimeoutSeconds: 120,
      maxArtifactBytes: 512 * 1024 * 1024,
      maxExpandedBytes: 1024 * 1024 * 1024,
      maxArchiveEntries: 10_000,
      totalTimeoutSeconds: 900,
    },
    actions: [],
    reviewedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function result(reviewed: DeploymentExecutionReviewV2): DeploymentExecutionResultV2 {
  return {
    schemaVersion: 2,
    operationId: reviewed.operationId,
    reviewId: reviewed.reviewId,
    documentDigest: reviewed.documentDigest,
    planDigest: reviewed.planDigest,
    deploymentId: reviewed.deploymentId,
    version: reviewed.version,
    target: reviewed.target,
    phase: 'succeeded',
    startedAt: 1,
    completedAt: 2,
    actions: [],
    healthChecks: [{
      checkId: 'web-http-health',
      kind: 'http',
      status: 'passed',
      attemptsUsed: 1,
      observedStatus: 200,
    }],
    rollbackSnapshot: {
      strategy: 'reactivatePreviousRelease',
      previousRelease: '/srv/acme-web/releases/acme-web-1.2.2',
      newRelease: '/srv/acme-web/releases/acme-web-1.2.3',
      releasesDirectory: '/srv/acme-web/releases',
      activeSymlink: '/srv/acme-web/current',
      activationChanged: true,
    },
  };
}

async function renderImportedReviewedPanel() {
  const runbookText = validDocumentText();
  const reviewed = review(runbookText);
  vi.spyOn(tauri, 'invokeListDeploymentRollouts').mockResolvedValue([]);
  vi.spyOn(tauri, 'invokeListDeploymentOperations').mockResolvedValue([]);
  vi.spyOn(tauri, 'invokeOpenRunbookFile').mockResolvedValue({
    path: 'C:\\fixtures\\deployment-v2.json',
    text: runbookText,
  });
  vi.spyOn(tauri, 'invokeReviewDeploymentExecution').mockResolvedValue(reviewed);
  const rendered = render(<DeploymentPanel />);
  await waitFor(() => expect(screen.getByText('deployment.backend.available')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /deployment.import/ }));
  await waitFor(() => expect(screen.getByDisplayValue('acme-web')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: /Production A/ }));
  const reviewButton = screen.getByRole('button', { name: 'deployment.review' });
  expect(reviewButton).toBeEnabled();
  fireEvent.click(reviewButton);
  await waitFor(() => expect(rendered.container.querySelector('[data-slot="deployment-review-summary"]')).toBeInTheDocument());
  return { ...rendered, reviewed };
}

describe('DeploymentPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    act(() => {
      useProfileStore.setState({ profiles: [], ensurePassword: originalEnsurePassword });
    });
  });

  it('keeps v2 inputs and target order frozen until the backend review is explicitly discarded', async () => {
    const ensurePassword = vi.fn(async (value: ConnectionProfile) => value);
    act(() => useProfileStore.setState({ profiles: [profile], ensurePassword }));
    const { container } = await renderImportedReviewedPanel();

    expect(screen.getByDisplayValue('1.2.3')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Production A/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /deployment.import/ })).toBeDisabled();
    expect(container.textContent).not.toContain(profile.password);
    expect(JSON.stringify(localStorage)).not.toContain(profile.password);

    fireEvent.click(screen.getByRole('button', { name: 'deployment.discardReview' }));
    expect(screen.getByDisplayValue('1.2.3')).toBeEnabled();
    expect(container.querySelector('[data-slot="deployment-review-summary"]')).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('1.2.3'), { target: { value: '1.2.4' } });
    expect(screen.getByDisplayValue('1.2.4')).toBeInTheDocument();
  });

  it('requires explicit confirmation and renders only the identity-checked backend result', async () => {
    act(() => useProfileStore.setState({
      profiles: [profile],
      ensurePassword: vi.fn(async (value: ConnectionProfile) => value),
    }));
    const { reviewed, container } = await renderImportedReviewedPanel();
    const execute = vi.spyOn(tauri, 'invokeExecuteDeployment').mockResolvedValue(result(reviewed));

    fireEvent.click(screen.getByRole('button', { name: 'deployment.approval.reviewSingle' }));
    const dialog = screen.getByRole('alertdialog');
    const confirmAction = within(dialog).getByRole('button', { name: 'deployment.approval.executeSingle' });
    expect(confirmAction).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(confirmAction).toBeEnabled();
    fireEvent.click(confirmAction);

    await waitFor(() => expect(container.querySelector('[data-slot="deployment-single-result"]')).toBeInTheDocument());
    expect(execute).toHaveBeenCalledOnce();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(JSON.stringify(execute.mock.calls[0])).toContain(reviewed.planDigest);
  });
});
