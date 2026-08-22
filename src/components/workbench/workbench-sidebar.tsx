import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useTrackpadSafeActivation } from '@/hooks/useTrackpadSafeActivation';
import { Sidebar } from '@/components/layout/app-shell';
import type { WorkbenchTab } from '@/types';
import {
  ActivityIcon,
  FileTextIcon,
  KeyRoundIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from 'lucide-react';

interface WorkbenchSidebarProps {
  activeTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
}

interface MenuItem {
  key: WorkbenchTab;
  label: string;
  icon: React.ElementType;
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
  const Icon = item.icon;
  const activation = useTrackpadSafeActivation(() => onActivate(item.key));

  return (
    <button
      {...activation}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-9 w-full items-center justify-start gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors [&_svg]:size-4',
        active
          ? 'bg-app-surface text-app-text shadow-sm ring-1 ring-app-border'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
    >
      <Icon aria-hidden="true" />
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
      icon: ServerIcon,
    },
    {
      key: 'keychain',
      label: t('workbench.keychain.title'),
      icon: KeyRoundIcon,
    },
    {
      key: 'knownHosts',
      label: t('workbench.knownHosts.title'),
      icon: ShieldCheckIcon,
    },
    {
      key: 'monitor',
      label: t('workbench.monitor.title'),
      icon: ActivityIcon,
    },
    {
      key: 'logs',
      label: t('workbench.logs.title'),
      icon: FileTextIcon,
    },
    {
      key: 'settings',
      label: t('workbench.settings.title'),
      icon: Settings2Icon,
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
