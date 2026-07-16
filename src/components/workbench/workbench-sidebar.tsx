import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Sidebar } from '@/components/layout/app-shell';

export type WorkbenchTab = 'connections' | 'knownHosts' | 'logs';

interface WorkbenchSidebarProps {
  activeTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
}

interface MenuItem {
  key: WorkbenchTab;
  label: string;
}

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
      key: 'knownHosts',
      label: t('workbench.knownHosts.title'),
    },
    {
      key: 'logs',
      label: t('workbench.logs.title'),
    },
  ];

  return (
    <Sidebar className="border-r border-app-border p-2">
      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          const active = activeTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onTabChange(item.key)}
              className={cn(
                'flex min-h-8 w-full items-center justify-start gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                active
                  ? 'bg-app-primary/10 text-app-primary'
                  : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
              )}
              title={item.label}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </Sidebar>
  );
};
