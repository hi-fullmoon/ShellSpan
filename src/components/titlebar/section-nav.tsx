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
      type="button"
      // WKWebView can occasionally lose the pointerdown from a macOS
      // tap-to-click gesture. Activate on pointerup so the release still
      // switches sections, while onClick keeps keyboard activation.
      onPointerUp={(event) => {
        if (event.button === 0) setActiveSection(section);
      }}
      onClick={(event) => {
        if (event.detail === 0) setActiveSection(section);
      }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-app-primary/10 text-app-primary'
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
