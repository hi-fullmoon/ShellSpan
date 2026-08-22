import React from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { useTrackpadSafeActivation } from '@/hooks/useTrackpadSafeActivation';
import type { AppSection } from '@/types';

interface NavItemProps {
  section: AppSection;
  label: string;
}

const NavItem: React.FC<NavItemProps> = ({ section, label }) => {
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
        'flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-app-surface-muted text-app-text font-semibold'
          : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
      )}
    >
      <span className="text-center">{label}</span>
    </button>
  );
};

export const SectionNav: React.FC = () => {
  const { t } = useI18n();

  return (
    <nav aria-label={t('app.primaryNavigation')} className="flex h-full items-center gap-1">
      <NavItem section="workbench" label={t('section.workbench')} />
      <NavItem section="terminal" label={t('section.terminal')} />
      <NavItem section="sftp" label={t('section.sftp')} />
    </nav>
  );
};
