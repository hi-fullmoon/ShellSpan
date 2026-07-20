import React from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import type { AppSection } from '@/types';

interface NavItemProps {
  section: AppSection;
  label: string;
}

const NavItem: React.FC<NavItemProps> = ({ section, label }) => {
  const { activeSection, setActiveSection } = useAppStore();
  const active = activeSection === section;

  return (
    <button
      onClick={() => setActiveSection(section)}
      className={cn(
        'flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-app-primary/10 text-app-primary'
          : 'text-app-text-soft hover:bg-app-surface-muted hover:text-app-text',
      )}
      data-tauri-drag-region="false"
    >
      <span className="text-center">{label}</span>
    </button>
  );
};

export const SectionNav: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center gap-1" data-tauri-drag-region="false">
      <NavItem section="workbench" label={t('section.workbench')} />
      <NavItem section="terminal" label={t('section.terminal')} />
      <NavItem section="sftp" label={t('section.sftp')} />
    </div>
  );
};
