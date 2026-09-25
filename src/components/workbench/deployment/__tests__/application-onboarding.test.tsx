import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import evidence from '../../../../../docs/design/deployment-center-product-phase-2-evidence.json';
import lifecycle from '../../../../../docs/design/deployment-center-product-phase-4-lifecycle-evidence.json';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';
import { t } from '@/locales';
import type { DeploymentReadinessReport, DeploymentApplicationEntry } from '@/lib/deployment/applications';
import { associateWorkflowDefaults, workflowMappingIssues } from '@/lib/deployment/applications';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { ApplicationOnboarding, ReadinessItems } from '../application-center';
import { WorkflowSettingsDialog } from '../workflow-settings-dialog';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';

// These are recorded outputs of the real Git/SQLite/Docker/SSH acceptance test,
// not fabricated API responses. No IPC, filesystem, or network is mocked here.
const report = evidence.report as DeploymentReadinessReport;
const workflow = evidence.workflow as unknown as DeploymentWorkflowRecord;
const entry = evidence.entry as DeploymentApplicationEntry;

describe('Application onboarding', () => {
  it('transfers focus from settings into configuration after settings closes', async () => {
    const triggerRef = React.createRef<HTMLButtonElement>();
    function View(): React.JSX.Element {
      const [settings, setSettings] = React.useState(false);
      const [configuration, setConfiguration] = React.useState(false);
      return <><button ref={triggerRef} onClick={() => setSettings(true)}>Settings</button>
        <WorkflowSettingsDialog open={settings} onOpenChange={setSettings} draft={{ ...workflow, layout: workflow.layout ?? { schemaVersion: 1, nodes: {}, groups: [] } }}
          editable returnFocusRef={triggerRef} onConfigureDeployment={() => setConfiguration(true)} />
        {configuration && <ApplicationOnboarding initial={null} workflowId={null} triggerRef={triggerRef}
          onSaved={() => undefined} onClose={() => setConfiguration(false)} />}</>;
    }
    const user = userEvent.setup();
    render(<View />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: t('deployment.application.configure') }));
    const name = await screen.findByLabelText(t('deployment.application.name'));
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    await user.click(name);
    await user.tab();
    expect(screen.getByLabelText(t('deployment.application.path'))).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(triggerRef.current).toHaveFocus());
  });

  it('shows exact read-only failures and actionable locations from real SSH evidence', async () => {
    render(<ReadinessItems report={report} />);
    await waitFor(() => expect(screen.getByText(t('deployment.application.check.directory'))).toBeVisible());
    expect(screen.getByText(t('deployment.application.fix.directory'))).toBeVisible();
    expect(screen.getByText(t('deployment.application.fix.disk'))).toBeVisible();
    expect(screen.getAllByText(entry.environment.config.remoteRoot).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t('deployment.application.blocked')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t('deployment.application.unchecked')).length).toBeGreaterThan(0);
    expect(evidence.missingRemoteDirectoryNotCreated).toBe(true);
  });

  it('keeps workflow configuration keyboard accessible without a separate step wizard', async () => {
    const triggerRef = React.createRef<HTMLButtonElement>();
    function View(): React.JSX.Element {
      const [open, setOpen] = React.useState(false);
      return <><button ref={triggerRef} onClick={() => setOpen(true)}>Connect</button>{open && <ApplicationOnboarding initial={null} workflowId={null} triggerRef={triggerRef} onSaved={() => undefined} onClose={() => setOpen(false)} />}</>;
    }
    render(<View />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog');
    const name = await screen.findByLabelText(t('deployment.application.name'));
    await user.click(name);
    await user.type(name, 'for-you');
    await user.tab();
    expect(screen.getByLabelText(t('deployment.application.path'))).toHaveFocus();
    expect(screen.queryByRole('button', { name: t('deployment.application.next') })).toBeNull();
    expect(screen.getByRole('button', { name: t('deployment.application.save') })).toBeDisabled();
    expect(dialog.className).toContain('flex-col');
    expect(dialog.className).toContain('100dvh');
    expect(dialog.querySelector('[data-slot="scroll-area"]')?.className).toContain('min-h-0');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(footer?.className).toContain('shrink-0');
    expect(footer?.className).not.toContain('border-t');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(triggerRef.current).toHaveFocus();
  });

  it('maps the recorded workflow without mutating its graph or source selection', () => {
    const before = JSON.stringify(workflow);
    expect(workflowMappingIssues(workflow)).toEqual([]);
    const associated = associateWorkflowDefaults(entry, workflow);
    expect(associated.environment.config.connectionProfileId).toBe(workflow.definition.targets[0]?.connectionProfileId);
    expect(associated.environment.config.projectName).toBe('for-you');
    expect(associated.source).toEqual(entry.source);
    expect(JSON.stringify(workflow)).toBe(before);
    expect(evidence.customNodesPreserved).toBe(true);
    expect(evidence.unmappableGraphTransactionRolledBack).toBe(true);
  });

  it('makes advanced managed-field changes read-only instead of overwriting them', () => {
    const changed = structuredClone(workflow);
    changed.definition.targets[0]!.remoteRoot += '-advanced';
    expect(workflowMappingIssues(changed, entry)).toContain('managedFields/remoteRoot');
    expect(workflow.definition.targets[0]!.remoteRoot).toBe(entry.environment.config.remoteRoot);
  });

  it('loads workflow platform only after an explicit choice and leaves saving to the user', async () => {
    const changed = structuredClone(workflow);
    const platform = entry.environment.config.platform === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64';
    const build = changed.definition.nodes.find((node) => node.type === 'build.docker-buildx')!;
    build.config = { ...build.config, platform };
    const before = useDeploymentWorkflowStore.getState();
    useDeploymentWorkflowStore.setState({ workflows: [changed] });
    try {
      render(<ApplicationOnboarding initial={entry} workflowId={changed.id} triggerRef={React.createRef<HTMLButtonElement>()}
        onSaved={() => { throw new Error('Review must not save automatically'); }} onClose={() => undefined} />);
      expect(screen.getByRole('button', { name: t('deployment.application.save') })).toBeDisabled();
      expect(screen.getByText(t('deployment.application.conflictField', {
        field: t('deployment.application.platform'), application: entry.environment.config.platform, workflow: platform,
      }))).toBeVisible();
      await userEvent.setup().click(screen.getByRole('button', { name: t('deployment.application.reconcileAction') }));
      expect(screen.getByText(t('deployment.application.reconcileReview'))).toBeVisible();
      expect(screen.getByRole('button', { name: t('deployment.application.save') })).toBeEnabled();
      expect(screen.getByText(platform === 'linux/arm64' ? 'Linux · ARM64' : 'Linux · x86-64')).toBeVisible();
      expect(entry.environment.config.platform).not.toBe(platform);
    } finally {
      useDeploymentWorkflowStore.setState(before, true);
    }
  });

  it('compares structured managed fields independently of JSON key order', () => {
    const changed = structuredClone(workflow);
    const build = changed.definition.nodes.find((node) => node.type === 'build.docker-buildx')!;
    const configured = structuredClone(entry);
    configured.environment.config.verification = { packageManager: 'npm', script: 'verify' };
    build.config = { ...build.config, verification: { script: 'verify', packageManager: 'npm' } };
    expect(workflowMappingIssues(changed, configured)).not.toContain('managedFields/verification');
  });

  it('preserves mount ownership and recovery metadata when adopting workflow settings', () => {
    const configured = structuredClone(entry);
    const changed = structuredClone(workflow);
    const recorded = lifecycle.failed.approvalSummary.releaseReview.configuration.find((node) => node.type === 'artifact.bundle-compose')!.config;
    const activation = lifecycle.failed.outputs.find((output) => output.outputName === 'activation')!.value.payload!;
    const mounts = recorded.registeredMounts!;
    configured.environment.config.dataDirectories = mounts.map((mount) => ({
      hostPath: mount.source, containerPath: mount.target, readOnly: mount.readOnly,
      containerUser: activation.containerUser!, backupPolicy: entry.environment.config.recoveryInstructions,
    }));
    const bundle = changed.definition.nodes.find((node) => node.type === 'artifact.bundle-compose')!;
    bundle.config = { ...bundle.config, registeredMounts: mounts };
    const associated = associateWorkflowDefaults(configured, changed);
    for (const directory of associated.environment.config.dataDirectories) {
      const existing = configured.environment.config.dataDirectories.find((item) => item.hostPath === directory.hostPath && item.containerPath === directory.containerPath);
      expect(existing).toBeDefined();
      expect(directory.containerUser).toBe(existing!.containerUser);
      expect(directory.backupPolicy).toBe(existing!.backupPolicy);
    }
    expect(associated.environment.config.dataDirectories.length).toBeGreaterThan(0);
  });

  it('has matching bilingual check and remediation keys for real recorded checks', () => {
    const zhKeys = Object.keys(zh).filter((key) => key.startsWith('deployment.application.')).sort();
    const enKeys = Object.keys(en).filter((key) => key.startsWith('deployment.application.')).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const item of report.items) {
      expect(zhKeys).toContain(`deployment.application.check.${item.key}`);
      expect(enKeys).toContain(`deployment.application.fix.${item.key}`);
      expect(zhKeys).toContain(`deployment.application.${item.status}`);
    }
  });
});
