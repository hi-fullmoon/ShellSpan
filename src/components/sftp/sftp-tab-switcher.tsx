import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { getShortcutKeys } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { useSftpStore } from '@/stores/sftpStore';

export function SftpTabSwitcher() {
  const { t } = useI18n();
  const platform = usePlatform();
  const connections = useSftpStore((state) => state.connections);
  const activeId = useSftpStore((state) => state.activeConnectionId);
  const binding = useAppStore((state) => state.shortcuts.switchSftpTab ?? DEFAULT_SHORTCUTS.switchSftpTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(() => connections.filter((connection) =>
    connection.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [connections, query]);

  useEffect(() => {
    const show = () => {
      setQuery('');
      setOpen(true);
    };
    document.addEventListener('shellspan:switch-sftp-tab', show);
    return () => document.removeEventListener('shellspan:switch-sftp-tab', show);
  }, []);

  useEffect(() => {
    setIndex(Math.max(0, filtered.findIndex((connection) => connection.id === activeId)));
  }, [activeId, filtered, open]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [index, open]);

  const select = (id: string) => {
    useSftpStore.getState().setActiveConnection(id);
    setOpen(false);
  };

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent className="flex h-[min(32rem,80dvh)] w-[calc(100%-2rem)] min-h-0 flex-col overflow-hidden" aria-describedby={undefined}>
      <DialogHeader className="shrink-0">
        <DialogTitle>{t('settings.shortcuts.switchSftpTab')}</DialogTitle>
      </DialogHeader>
      <InputGroup className="shrink-0">
        <InputGroupInput autoFocus type="search" value={query}
          aria-label={t('sftp.tabSwitcher.search')} placeholder={t('sftp.tabSwitcher.search')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (filtered.length) setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (filtered[index]) select(filtered[index].id);
            }
          }} />
        {binding && <InputGroupAddon align="inline-end"><Kbd>{getShortcutKeys(binding, platform).join(' ')}</Kbd></InputGroupAddon>}
      </InputGroup>
      <ScrollArea className="min-h-0 flex-1">
        <div role="listbox" aria-label={t('settings.shortcuts.switchSftpTab')} className="flex flex-col gap-1">
          {filtered.map((connection, itemIndex) => <Button key={connection.id} role="option"
            ref={index === itemIndex ? selectedRef : undefined}
            aria-selected={index === itemIndex} variant={index === itemIndex ? 'secondary' : 'ghost'}
            className="w-full justify-start" onMouseEnter={() => setIndex(itemIndex)} onFocus={() => setIndex(itemIndex)}
            onClick={() => select(connection.id)}>
            <span className="truncate">{connection.title}</span>
          </Button>)}
          {!filtered.length && <p className="p-4 text-sm text-muted-foreground">{t('sftp.tabSwitcher.empty')}</p>}
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>;
}
