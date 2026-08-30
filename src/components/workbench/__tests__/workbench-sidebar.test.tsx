import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkbenchSidebar } from '../workbench-sidebar';
import { useUpdateStore } from '@/stores/updateStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'workbench.connections.title': 'Connections',
      'workbench.keychain.title': 'Keychain',
      'workbench.knownHosts.title': 'Known Hosts',
      'workbench.monitor.title': 'Monitor',
      'workbench.logs.title': 'Log explorer',
      'workbench.settings.title': 'Settings',
      'workbench.userMenu.open': 'Open user menu',
      'workbench.userMenu.name': 'Me',
      'workbench.userMenu.localProfile': 'Local profile',
      'workbench.userMenu.about': 'About',
      'workbench.userMenu.checkingUpdate': 'Checking for updates…',
      'workbench.userMenu.downloadingUpdate': 'Downloading update…',
      'workbench.userMenu.quit': 'Quit',
      'settings.appearance.title': 'Appearance',
      'settings.shortcuts.title': 'Keyboard shortcuts',
      'settings.general.checkUpdate': 'Check for updates',
    })[key] ?? key,
  }),
}));

describe('WorkbenchSidebar', () => {
  beforeEach(() => {
    useUpdateStore.setState({ phase: 'idle' });
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

  it('keeps menu separators inset from the popup edges', () => {
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
    const separators = document.querySelectorAll('[data-slot="dropdown-menu-separator"]');
    expect(separators).toHaveLength(2);
    separators.forEach((separator) => expect(separator).toHaveClass('mx-0'));
  });

  it('uses the softer application text color for menu actions', () => {
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
    const actionGroups = document.querySelectorAll(
      '[data-slot="dropdown-menu-group"].text-app-text-soft',
    );
    expect(actionGroups).toHaveLength(2);
    actionGroups.forEach((group) => {
      expect(group).toHaveClass('[&_[data-slot=dropdown-menu-item]]:text-[13px]');
      const icons = group.querySelectorAll('svg');
      expect(icons).toHaveLength(3);
      icons.forEach((icon) => expect(icon).toHaveClass('size-3.5'));
    });
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
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveClass('size-3.5');
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
