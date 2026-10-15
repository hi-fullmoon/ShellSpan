import React from 'react';
import { FolderIcon, LayoutDashboardIcon, SquareTerminalIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { useTrackpadSafeActivation } from '@/hooks/useTrackpadSafeActivation';
import type { AppSection } from '@/types';

interface NavItemProps {
  section: AppSection;
  label: string;
  icon: LucideIcon;
}

const NavItem: React.FC<NavItemProps> = ({ section, label, icon: Icon }) => {
  const activeSection = useAppStore((state) => state.activeSection);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const active = activeSection === section;
  const activate = React.useCallback(() => setActiveSection(section), [section, setActiveSection]);
  const activation = useTrackpadSafeActivation(activate);

  return (
    <button
      {...activation}
      type="button"
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-7 min-w-20 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-normal transition-colors',
        active
          ? 'bg-app-surface-muted text-app-text font-medium'
          : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span
        data-label={label}
        className="text-center [text-box:trim-both_text_alphabetic] after:invisible after:block after:h-0 after:overflow-hidden after:font-medium after:content-[attr(data-label)]"
      >
        {label}
      </span>
    </button>
  );
};

export const SectionNav: React.FC = () => {
  const { t } = useI18n();

  return (
    <nav aria-label={t('app.primaryNavigation')} className="flex h-full items-center gap-1">
      <NavItem section="workbench" label={t('section.workbench')} icon={LayoutDashboardIcon} />
      <NavItem section="terminal" label={t('section.terminal')} icon={SquareTerminalIcon} />
      <NavItem section="sftp" label={t('section.sftp')} icon={FolderIcon} />
    </nav>
  );
};
