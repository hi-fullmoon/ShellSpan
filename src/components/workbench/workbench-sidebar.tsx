import React from 'react';
import { cn } from '@/lib/utils';
import { getPlatform } from '@/lib/platform';
import { getShortcutKeys } from '@/lib/shortcuts';
import { useI18n } from '@/hooks/useI18n';
import { useTrackpadSafeActivation } from '@/hooks/useTrackpadSafeActivation';
import { Sidebar } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SettingsSection, WorkbenchTab } from '@/types';
import { useUpdateStore } from '@/stores/updateStore';
import { useAppStore } from '@/stores/appStore';
import {
  ActivityIcon,
  ChevronUpIcon,
  FileTextIcon,
  InfoIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LogOutIcon,
  PaletteIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from 'lucide-react';

interface WorkbenchSidebarProps {
  activeTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onCheckForUpdates: () => void;
  onOpenAbout: () => void;
  onRequestExit: () => void;
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
        'flex h-8 w-full items-center justify-start gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors [&_svg]:size-4',
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
  onOpenSettings,
  onCheckForUpdates,
  onOpenAbout,
  onRequestExit,
}) => {
  const { t } = useI18n();
  const settingsShortcut = useAppStore((state) => state.shortcuts.openSettings);
  const platform = getPlatform();
  const settingsShortcutLabel = getShortcutKeys(settingsShortcut, platform)
    .join(platform === 'macos' ? '' : '+');
  const updatePhase = useUpdateStore((state) => state.phase);
  const checkingForUpdates = updatePhase === 'checking';
  const downloadingUpdate = updatePhase === 'update_available' || updatePhase === 'downloading';
  const updateBusy = checkingForUpdates || downloadingUpdate;

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
  ];

  return (
    <Sidebar className="border-r border-app-border/50 p-2">
      <nav className="flex flex-1 flex-col gap-1">
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start px-2 py-1.5 hover:bg-app-surface/70 data-popup-open:bg-app-surface"
              aria-label={t('workbench.userMenu.open')}
            />
          }
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 leading-none">
            <span className="text-sm font-medium text-foreground">{t('workbench.userMenu.name')}</span>
            <span className="text-[11px] text-muted-foreground">{t('workbench.userMenu.localProfile')}</span>
          </span>
          <ChevronUpIcon data-icon="inline-end" className="text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={6}
          className="workbench-user-menu w-(--anchor-width) max-w-[calc(100vw-1rem)] rounded-2xl border border-border p-1 shadow-[var(--shadow-dialog)] ring-0 backdrop-blur-xl"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-2 px-1.5 pt-1.5 pb-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-3.5">
                <UserRoundIcon aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5 leading-[18px]">
                <span className="truncate text-sm font-medium text-foreground">{t('workbench.userMenu.name')}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">{t('workbench.userMenu.localProfile')}</span>
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onOpenSettings('general')}>
              <SettingsIcon aria-hidden />
              {t('workbench.settings.title')}
              <DropdownMenuShortcut aria-hidden>{settingsShortcutLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenSettings('appearance')}>
              <PaletteIcon aria-hidden />
              {t('settings.appearance.title')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenSettings('shortcuts')}>
              <KeyboardIcon aria-hidden />
              {t('settings.shortcuts.title')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuGroup>
            <DropdownMenuItem
              closeOnClick={false}
              disabled={updateBusy}
              onClick={onCheckForUpdates}
            >
              {updateBusy
                ? <Spinner />
                : <RefreshCwIcon aria-hidden />}
              {checkingForUpdates
                ? t('workbench.userMenu.checkingUpdate')
                : downloadingUpdate
                  ? t('workbench.userMenu.downloadingUpdate')
                  : t('settings.general.checkUpdate')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenAbout}>
              <InfoIcon aria-hidden />
              {t('workbench.userMenu.about')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRequestExit}>
              <LogOutIcon aria-hidden />
              {t('workbench.userMenu.quit')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Sidebar>
  );
};
