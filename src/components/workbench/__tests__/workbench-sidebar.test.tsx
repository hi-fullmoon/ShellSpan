import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WorkbenchSidebar } from '../workbench-sidebar';
import { useAppStore } from '@/stores/appStore';
import { useUpdateStore } from '@/stores/updateStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import type { DeploymentRunSummary } from '@/lib/deployment/types';

function runSummary(
  runId: string,
  status: DeploymentRunSummary['status'],
): DeploymentRunSummary {
  return {
    runId,
    workflowId: 'workflow-1',
    workflowRevision: 1,
    operationKind: 'deploy',
    triggerKind: 'manual',
    status,
    planDigest: 'sha256:plan',
    targetRelease: {
      releaseId: 'release-1',
      artifactContentDigest: 'sha256:artifact',
      layoutDigest: 'sha256:layout',
    },
    artifactReferences: [],
    expiresAt: Date.now() + 60_000,
    expired: false,
    planDrifted: false,
    createdAt: 10,
    updatedAt: 11,
    startedAt: null,
    finishedAt: null,
  };
}

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'workbench.connections.title': 'Connections',
      'workbench.keychain.title': 'Keychain',
      'deployment.title': 'Deployments',
      'workbench.knownHosts.title': 'Known Hosts',
      'workbench.monitor.title': 'Monitor',
      'workbench.logs.title': 'Log explorer',
      'workbench.settings.title': 'Settings',
      'workbench.userMenu.open': 'Open user menu',
      'workbench.userMenu.name': 'Me',
      'workbench.userMenu.editProfile': 'Edit profile',
      'workbench.userMenu.localProfile': 'Local profile',
      'workbench.userMenu.about': 'About',
      'workbench.userMenu.checkingUpdate': 'Checking for updates…',
      'workbench.userMenu.downloadingUpdate': 'Downloading update…',
      'workbench.userMenu.quit': 'Quit',
      'settings.appearance.title': 'Appearance',
      'settings.shortcuts.title': 'Keyboard shortcuts',
      'settings.general.checkUpdate': 'Check for updates',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
    })[key] ?? key,
  }),
}));

describe('WorkbenchSidebar', () => {
  beforeEach(() => {
    useUpdateStore.setState({ phase: 'idle' });
    useAppStore.setState({ profileName: '', profileAvatar: '' });
    useDeploymentWorkflowRunStore.setState({ runs: [] });
  });

  it('activates the deployment center menu entry', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} onOpenSettings={vi.fn()} onCheckForUpdates={vi.fn()} onOpenAbout={vi.fn()} onRequestExit={vi.fn()} />);

    const deployments = screen.getByRole('button', { name: 'Deployments' });
    expect(deployments).toBeInTheDocument();
    expect(screen.getAllByRole('button', {
      name: /^(Connections|Deployments|Keychain|Known Hosts|Monitor|Log explorer)$/,
    }).map((button) => button.textContent)).toEqual([
      'Connections', 'Deployments', 'Keychain', 'Known Hosts', 'Monitor', 'Log explorer',
    ]);

    fireEvent.click(deployments, { detail: 0 });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('deployments');
  });

  it('badges the deployment entry with runs awaiting reconciliation', () => {
    useDeploymentWorkflowRunStore.setState({
      runs: [
        runSummary('run-1', 'state_unknown'),
        runSummary('run-2', 'state_unknown'),
        runSummary('run-3', 'succeeded'),
      ],
    });
    render(<WorkbenchSidebar activeTab="deployments" onTabChange={vi.fn()} onOpenSettings={vi.fn()} onCheckForUpdates={vi.fn()} onOpenAbout={vi.fn()} onRequestExit={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Deployments/ })).toHaveTextContent('2');
  });

  it('activates a menu item when WKWebView drops its trackpad pointerdown', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} onOpenSettings={vi.fn()} onCheckForUpdates={vi.fn()} onOpenAbout={vi.fn()} onRequestExit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Runbooks' })).not.toBeInTheDocument();
    const keychain = screen.getByRole('button', { name: 'Keychain' });
    expect(keychain).toHaveClass('h-8');

    fireEvent.pointerUp(keychain, {
      button: 0,
      pointerId: 12,
      pointerType: 'mouse',
    });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('keychain');
  });

  it('does not activate the same pointer tap twice when its click is delivered', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} onOpenSettings={vi.fn()} onCheckForUpdates={vi.fn()} onOpenAbout={vi.fn()} onRequestExit={vi.fn()} />);
    const keychain = screen.getByRole('button', { name: 'Keychain' });

    fireEvent.pointerDown(keychain, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.pointerUp(keychain, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.click(keychain, { detail: 1 });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('keychain');
  });

  it('retains keyboard click activation', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} onOpenSettings={vi.fn()} onCheckForUpdates={vi.fn()} onOpenAbout={vi.fn()} onRequestExit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Keychain' }), { detail: 0 });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('keychain');
  });

  it('shows a highlighted user placeholder that opens a quick-access menu', () => {
    const onTabChange = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={onTabChange}
        onOpenSettings={onOpenSettings}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Open user menu' });
    expect(trigger).toHaveTextContent('Me');
    expect(trigger).toHaveTextContent('Local profile');
    expect(trigger).toHaveClass('hover:bg-app-surface/70');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

    expect(onOpenSettings).toHaveBeenCalledWith('general');
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('shows the custom profile name and avatar on the trigger', () => {
    const avatar = 'data:image/png;base64,aGVsbG8=';
    useAppStore.setState({ profileName: '小明', profileAvatar: avatar });
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Open user menu/ });
    expect(trigger).toHaveTextContent('小明');
    expect(trigger).not.toHaveTextContent('Me');
    const avatarImage = screen.getByRole('img', { name: '小明' });
    expect(avatarImage).toHaveAttribute('src', avatar);
  });

  it('keeps an overlong profile name on a single truncated line in the trigger', () => {
    const longName = '天'.repeat(32);
    useAppStore.setState({ profileName: longName });
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    const nameLine = screen.getByText(longName);
    expect(nameLine).toHaveClass('truncate', 'max-w-full');
  });

  it('enlarges the avatar in the user menu header', () => {
    const avatar = 'data:image/png;base64,aGVsbG8=';
    useAppStore.setState({ profileName: '小明', profileAvatar: avatar });
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));

    const menu = screen.getByRole('menu');
    const headerAvatar = within(menu).getByAltText('小明');
    expect(headerAvatar.parentElement).toHaveClass('size-10', 'shrink-0');
  });

  it('opens the profile dialog from the identity row in the user menu', async () => {
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    // The identity row itself is the profile entry (GitHub-style), announced
    // via the screen-reader-only "Edit profile" hint.
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit profile/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Edit profile');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('opens the appearance section from the user menu', () => {
    const onOpenSettings = vi.fn();
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={onOpenSettings}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Appearance' }));

    expect(onOpenSettings).toHaveBeenCalledWith('appearance');
  });

  it('connects update checking and about to the application actions', () => {
    const onCheckForUpdates = vi.fn();
    const onOpenAbout = vi.fn();
    const onRequestExit = vi.fn();
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={onCheckForUpdates}
        onOpenAbout={onOpenAbout}
        onRequestExit={onRequestExit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Check for updates' }));
    expect(onCheckForUpdates).toHaveBeenCalledOnce();

    expect(screen.getByRole('menuitem', { name: 'About' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'About' }));
    expect(onOpenAbout).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    const quit = screen.getByRole('menuitem', { name: 'Quit' });
    expect(quit).toHaveAttribute('data-variant', 'default');
    expect(screen.queryByText('Quick access')).not.toBeInTheDocument();
    expect(screen.queryByText('Application')).not.toBeInTheDocument();
    fireEvent.click(quit);
    expect(onRequestExit).toHaveBeenCalledOnce();
  });

  it('shows a disabled loading state while checking for updates', () => {
    const onCheckForUpdates = vi.fn();
    useUpdateStore.setState({ phase: 'checking' });
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={onCheckForUpdates}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    const checkingItem = screen.getByRole('menuitem', { name: /Checking for updates/ });
    expect(checkingItem).toHaveAttribute('data-disabled');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    fireEvent.click(checkingItem);
    expect(onCheckForUpdates).not.toHaveBeenCalled();
  });

  it('switches to a loading download label when an update is found', () => {
    useUpdateStore.setState({ phase: 'downloading' });
    render(
      <WorkbenchSidebar
        activeTab="connections"
        onTabChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onCheckForUpdates={vi.fn()}
        onOpenAbout={vi.fn()}
        onRequestExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }));
    const downloadingItem = screen.getByRole('menuitem', { name: /Downloading update/ });
    expect(downloadingItem).toHaveAttribute('data-disabled');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});
