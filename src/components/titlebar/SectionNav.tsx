import React from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { useSftpStore } from '@/stores/sftpStore';
import type { AppSection } from '@/types';

interface NavItemProps {
  section: AppSection;
  label: string;
  badge?: number;
}

const NavItem: React.FC<NavItemProps> = ({ section, label, badge }) => {
  const { activeSection, setActiveSection } = useAppStore();
  const active = activeSection === section;

  return (
    <button
      onClick={() => setActiveSection(section)}
      className={cn(
        'flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-app-surface text-app-primary shadow-sm'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
      title={label}
      data-tauri-drag-region="false"
    >
      <span className="text-center">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-app-primary px-1 text-[10px] text-app-primary-text">
          {badge}
        </span>
      )}
    </button>
  );
};

export const SectionNav: React.FC = () => {
  const { t } = useI18n();
  const sftpCount = useSftpStore((state) => state.connections.length);

  return (
    <div className="flex h-full items-center gap-1" data-tauri-drag-region="false">
      <NavItem section="workbench" label={t('section.workbench')} />
      <NavItem section="terminal" label={t('section.terminal')} />
      <NavItem section="sftp" label={t('section.sftp')} badge={sftpCount} />
    </div>
  );
};
