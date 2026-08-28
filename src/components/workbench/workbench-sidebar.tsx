import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useTrackpadSafeActivation } from '@/hooks/useTrackpadSafeActivation';
import { Sidebar } from '@/components/layout/app-shell';
import type { WorkbenchTab } from '@/types';

interface WorkbenchSidebarProps {
  activeTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
}

interface MenuItem {
  key: WorkbenchTab;
  label: string;
}

interface WorkbenchSidebarItemProps {
  item: MenuItem;
  active: boolean;
  onActivate: (tab: WorkbenchTab) => void;
}

const WorkbenchSidebarItem: React.FC<WorkbenchSidebarItemProps> = ({
  item,
  active,
  onActivate,
}) => {
  const activation = useTrackpadSafeActivation(() => onActivate(item.key));

  return (
    <button
      {...activation}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center justify-start rounded-lg px-3 text-[13px] font-medium transition-colors',
        active
          ? 'bg-app-surface text-app-text shadow-sm ring-1 ring-app-border'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
    >
      {item.label}
    </button>
  );
};

export const WorkbenchSidebar: React.FC<WorkbenchSidebarProps> = ({
  activeTab,
  onTabChange,
}) => {
  const { t } = useI18n();

  const items: MenuItem[] = [
    {
      key: 'connections',
      label: t('workbench.connections.title'),
    },
    {
      key: 'keychain',
      label: t('workbench.keychain.title'),
    },
    {
      key: 'knownHosts',
      label: t('workbench.knownHosts.title'),
    },
    {
      key: 'deployments',
      label: t('deployment.title'),
    },
    {
      key: 'history',
      label: t('operationHistory.title'),
    },
    {
      key: 'monitor',
      label: t('workbench.monitor.title'),
    },
    {
      key: 'logs',
      label: t('workbench.logs.title'),
    },
    {
      key: 'settings',
      label: t('workbench.settings.title'),
    },
  ];

  return (
    <Sidebar className="border-r border-app-border/50 p-2">
      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          return (
            <WorkbenchSidebarItem
              key={item.key}
              item={item}
              active={activeTab === item.key}
              onActivate={onTabChange}
            />
          );
        })}
      </nav>
    </Sidebar>
  );
};
