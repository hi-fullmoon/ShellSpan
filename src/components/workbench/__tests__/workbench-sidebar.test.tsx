import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkbenchSidebar } from '../workbench-sidebar';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'workbench.connections.title': 'Connections',
      'workbench.keychain.title': 'Keychain',
      'workbench.knownHosts.title': 'Known Hosts',
      'workbench.monitor.title': 'Monitor',
      'workbench.logs.title': 'Log explorer',
      'workbench.settings.title': 'Settings',
    })[key] ?? key,
  }),
}));

describe('WorkbenchSidebar', () => {
  it('activates a menu item when WKWebView drops its trackpad pointerdown', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} />);
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
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} />);
    const keychain = screen.getByRole('button', { name: 'Keychain' });

    fireEvent.pointerDown(keychain, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.pointerUp(keychain, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.click(keychain, { detail: 1 });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('keychain');
  });

  it('retains keyboard click activation', () => {
    const onTabChange = vi.fn();
    render(<WorkbenchSidebar activeTab="connections" onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Keychain' }), { detail: 0 });

    expect(onTabChange).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith('keychain');
  });
});
