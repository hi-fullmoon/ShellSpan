import React from 'react';
import { FolderIcon, PanelsTopLeftIcon, SquareTerminalIcon, type LucideIcon } from 'lucide-react';
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
        'flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0',
        active
          ? 'bg-app-tab-active text-app-tab-accent'
          : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
      )}
    >
      <Icon
        aria-hidden="true"
        // Folder's outline spans y=3..20; match the other icons' y=3..21 outline.
        viewBox={section === 'sftp' ? '0 0.1666666667 24 22.6666666667' : '0 0 24 24'}
        preserveAspectRatio="none"
      />
      <span className="translate-y-px text-center">{label}</span>
    </button>
  );
};

export const SectionNav: React.FC = () => {
  const { t } = useI18n();

  return (
    <nav aria-label={t('app.primaryNavigation')} className="flex h-full items-center gap-1">
      <NavItem section="workbench" label={t('section.workbench')} icon={PanelsTopLeftIcon} />
      <NavItem section="terminal" label={t('section.terminal')} icon={SquareTerminalIcon} />
      <NavItem section="sftp" label={t('section.sftp')} icon={FolderIcon} />
    </nav>
  );
};
