import { cn } from '../lib/ui';
import { t } from '../lib/i18n';
import { ScrollArea } from './ui';
import {
  HostsIcon,
  KeychainIcon,
  ForwardingIcon,
  SnippetsIcon,
  FingerprintIcon,
  ClockIcon,
} from './ui/Icons';
import type { MyMenuKey } from '../types';

interface MySidebarProps {
  activeMenu: MyMenuKey;
  onMenuChange: (menu: MyMenuKey) => void;
}

const MENU_ITEMS: { key: MyMenuKey; labelKey: string; icon: React.FC<{ className?: string }> }[] = [
  { key: 'savedConnections', labelKey: 'my.menu.savedConnections', icon: HostsIcon },
  { key: 'keychain', labelKey: 'my.menu.keychain', icon: KeychainIcon },
  { key: 'portForwards', labelKey: 'my.menu.portForwards', icon: ForwardingIcon },
  { key: 'snippets', labelKey: 'my.menu.snippets', icon: SnippetsIcon },
  { key: 'knownHosts', labelKey: 'my.menu.knownHosts', icon: FingerprintIcon },
  { key: 'logs', labelKey: 'my.menu.logs', icon: ClockIcon },
];

export function MySidebar({ activeMenu, onMenuChange }: MySidebarProps) {
  return (
    <aside className="flex h-full w-44 min-w-0 flex-col overflow-hidden border-r border-[var(--app-border)] bg-[var(--app-bg)]">
      <ScrollArea className="flex-1 py-2">
        <nav className="flex flex-col gap-0.5 px-2" role="tablist" aria-label={t('nav.my')}>
          {MENU_ITEMS.map((item) => {
            const active = activeMenu === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                aria-selected={active}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition',
                  active
                    ? 'bg-[var(--app-surface-muted)] text-[var(--app-text)]'
                    : 'text-[var(--app-text-soft)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text)]',
                )}
                onClick={() => onMenuChange(item.key)}
                role="tab"
                type="button"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>
      </ScrollArea>
    </aside>
  );
}
