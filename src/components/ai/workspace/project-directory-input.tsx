import { useEffect, useId, useRef, useState } from 'react';
import { FolderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { useI18n } from '@/hooks/useI18n';
import type { ListProjectDirectories } from '@/types/agent-file-reference';

export function ProjectDirectoryInput({ id, value, onChange, disabled, list, onConfirm }: {
  id: string; value: string; onChange: (value: string) => void; disabled: boolean;
  list?: ListProjectDirectories; onConfirm: () => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [entries, setEntries] = useState<readonly string[]>([]);
  const [index, setIndex] = useState(-1);
  const [focused, setFocused] = useState(true);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const current = useRef(value); current.current = value;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    setEntries([]); setIndex(-1); setStatus('idle');
    if (!list || disabled || !focused || composing || dismissed || !value) return;
    const timer = setTimeout(() => {
      setStatus('loading');
      void list(value, abort.signal).then(result => {
        if (abort.signal.aborted || current.current !== value) return;
        setEntries(result); setStatus('ready');
      }, () => {
        if (!abort.signal.aborted && current.current === value) setStatus('error');
      });
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [value, list, disabled, focused, composing, dismissed]);
  const choose = (path: string) => { setEntries([]); setIndex(-1); onChange(path); input.current?.focus(); };
  const visible = focused && !dismissed && !disabled && !composing;
  const expanded = visible && entries.length > 0;
  return <>
    <Input ref={input} id={id} value={value} disabled={disabled} autoFocus
      role={list ? 'combobox' : undefined} aria-autocomplete={list ? 'list' : undefined}
      aria-expanded={list ? expanded : undefined} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && index >= 0 ? `${listId}-${index}` : undefined}
      onChange={event => { setEntries([]); setIndex(-1); setDismissed(false); onChange(event.target.value); }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && visible && (entries.length || status !== 'idle')) {
          event.preventDefault(); setDismissed(true); return;
        }
        if (expanded && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          const next = (index + (event.key === 'ArrowDown' ? 1 : index < 0 ? 0 : -1) + entries.length) % entries.length;
          setIndex(next); document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
        } else if (expanded && (event.key === 'Tab' || (event.key === 'Enter' && index >= 0))) {
          event.preventDefault(); choose(entries[Math.max(0, index)]);
        } else if (event.key === 'Enter') {
          event.preventDefault(); if (value.trim() && !disabled) onConfirm();
        }
      }} />
    {visible && (entries.length > 0 || status !== 'idle') && <Popover open onOpenChange={(open, details) => {
      if (open) return;
      if (details.event.target instanceof Node && input.current?.contains(details.event.target)) { details.cancel(); return; }
      setDismissed(true);
    }}>
      <PopoverContent anchor={input} side="bottom" align="start" sideOffset={4} collisionPadding={8}
        positionMethod="fixed" initialFocus={false} finalFocus={false} role="presentation"
        onMouseDown={event => event.preventDefault()}
        className="max-h-[min(240px,var(--available-height))] w-(--anchor-width) max-w-(--available-width) overflow-y-auto p-1 data-open:animate-none data-closed:animate-none">
        {expanded && <div id={listId} role="listbox" aria-label={t('ai.workspace.skills.root')} className="flex min-w-0 flex-col">
          {entries.map((path, position) => <Button key={path} id={`${listId}-${position}`} type="button"
            role="option" aria-selected={index === position} tabIndex={-1} variant={index === position ? 'secondary' : 'ghost'}
            title={path} className="w-full justify-start" onMouseDown={event => event.preventDefault()} onClick={() => choose(path)}>
            <FolderIcon data-icon="inline-start" /><span className="truncate">{path}</span>
          </Button>)}
        </div>}
        {status !== 'idle' && !entries.length && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {t(status === 'loading' ? 'ai.workspace.files.loading' : status === 'error' ? 'ai.workspace.files.directoryUnavailable' : 'ai.workspace.files.directoryEmpty')}
        </p>}
      </PopoverContent>
    </Popover>}
  </>;
}
