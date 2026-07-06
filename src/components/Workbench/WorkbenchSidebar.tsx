import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Sidebar } from '@/components/layout/AppShell';

export type WorkbenchTab = 'connections' | 'knownHosts' | 'logs';

interface WorkbenchSidebarProps {
  activeTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
}

interface MenuItem {
  key: WorkbenchTab;
  label: string;
  icon: React.ReactNode;
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
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      ),
    },
    {
      key: 'knownHosts',
      label: t('workbench.knownHosts.title'),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
    },
    {
      key: 'logs',
      label: t('workbench.logs.title'),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
    },
  ];

  return (
    <Sidebar className="p-2">
      <nav className="flex flex-col gap-1">
        {items.map((item) => {
          const active = activeTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onTabChange(item.key)}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1.5 text-xs font-medium transition-colors',
                active
                  ? 'rounded-full bg-app-surface text-app-primary shadow-sm'
                  : 'rounded-lg text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
              )}
              title={item.label}
            >
              <span className="flex h-4 w-4 items-center justify-center">{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </Sidebar>
  );
};
