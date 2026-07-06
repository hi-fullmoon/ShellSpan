import React from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSftpStore } from '@/stores/sftpStore';
import type { AppSection } from '@/types';

interface NavItemProps {
  section: AppSection;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

const NavItem: React.FC<NavItemProps> = ({ section, icon, label, badge }) => {
  const { activeSection, setActiveSection } = useAppStore();
  const active = activeSection === section;

  return (
    <button
      onClick={() => setActiveSection(section)}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-app-surface text-app-primary shadow-sm'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
      title={label}
      data-tauri-drag-region="false"
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span>{label}</span>
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
  const terminalCount = useTerminalStore((state) => state.sessions.length);
  const sftpCount = useSftpStore((state) => state.connections.length);

  return (
    <div className="flex h-full items-center gap-1" data-tauri-drag-region="false">
      <NavItem
        section="workbench"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        }
        label={t('section.workbench')}
      />
      <NavItem
        section="terminal"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        }
        label={t('section.terminal')}
        badge={terminalCount}
      />
      <NavItem
        section="sftp"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        }
        label={t('section.sftp')}
        badge={sftpCount}
      />
    </div>
  );
};
