import { useEffect, useId, useRef, useState } from 'react';
import { AtSignIcon, ChevronRightIcon, CornerDownLeftIcon, FileIcon, FolderIcon, FolderOpenIcon, InfoIcon, MessageCircleIcon, RefreshCwIcon, ServerIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { ProjectDirectoryInput } from './project-directory-input';
import { EmptyState } from '@/components/ui/empty-state';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { activeFileToken, insertFileMention } from '@/lib/ai/file-reference-grammar';
import type { FileCandidate, FileReferenceList, ListFileReferences } from '@/types/agent-file-reference';
import type { ComposerEditorHandle } from './ai-composer-editor';
import { AiErrorNotice } from './ai-error-notice';
import { AiMentionPanel, type MentionContext, type MentionGroup, type MentionOption } from './ai-mention-panel';
import { useComposerMenuGroups } from './ai-composer-menu-content';
import { isTopLevelAiSession } from '@/lib/ai/session-list';

export function useFileCompletion({ text, update, query, listDirectories, scopeKey, needsRoot, targetLabel, disabled, context }: {
  text: string; update: (value: string) => void; query?: ListFileReferences; scopeKey?: string;
  needsRoot?: boolean; targetLabel?: string; disabled: boolean;
  listDirectories?: import('@/types/agent-file-reference').ListProjectDirectories;
  context?: MentionContext;
}) {
  const { t } = useI18n();
  const editor = useRef<ComposerEditorHandle>(null);
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<FileReferenceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const [rootOpen, setRootOpen] = useState(false);
  const [root, setRoot] = useState('');
  const [binding, setBinding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const historyRequested = useRef(false);
  const rootAbort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const id = useId();
  const token = activeFileToken(text, ...selection);
  const key = JSON.stringify([scopeKey, text, ...selection]);
  const currentKey = useRef(key); currentKey.current = key;
  // Dismiss only this visit to the token. Editing away must retire the old key,
  // otherwise returning to identical text keeps its list hidden indefinitely.
  useEffect(() => { setDismissed(previous => previous === key ? previous : null); }, [key]);
  const open = Boolean((query || context) && token && !disabled && !composing && focused && dismissed !== key);
  const queryText = token?.query ?? '';
  const rootRequired = needsRoot || Boolean(error && /RootRequired/.test(error));
  const showFiles = Boolean(query && (!context || browsing || queryText));
  useEffect(() => {
    if (!open) { historyRequested.current = false; setBrowsing(false); return; }
    if (context && queryText.trim() && !historyRequested.current) {
      historyRequested.current = true;
      context.onRefreshSessions?.();
    }
  }, [open, queryText, context]);
  useEffect(() => {
    const generation = ++version.current;
    const abort = new AbortController();
    setResult(null); setError(null); setIndex(0); setLoading(false);
    if (!open || rootOpen || !query || !showFiles || (context && needsRoot)) return () => { abort.abort(); version.current++; };
    setLoading(true);
    const timer = setTimeout(() => {
      void query(queryText, abort.signal).then(value => {
        if (!abort.signal.aborted && generation === version.current && currentKey.current === key) {
          setResult(value); setError(value.code); setLoading(false);
        }
      }, failure => {
        if (!abort.signal.aborted && generation === version.current && currentKey.current === key) { setError(String(failure)); setLoading(false); }
      });
    }, 100);
    return () => { clearTimeout(timer); abort.abort(); version.current++; };
  }, [key, open, query, queryText, needsRoot, rootOpen, showFiles, context !== undefined]);
  useEffect(() => { setRootOpen(false); setRoot(''); setBinding(false); rootAbort.current?.abort(); }, [scopeKey]);
  useEffect(() => () => { rootAbort.current?.abort(); }, []);
  const errorText = (code: string): string => {
    if (/RootRequired/.test(code)) return t('ai.workspace.files.rootRequired');
    if (/Absent/.test(code)) return t('ai.workspace.files.absent');
    if (/Denied|InvalidRequest/.test(code)) return t('ai.workspace.files.denied');
    if (/Drift|identity/.test(code)) return t('ai.workspace.files.drift');
    if (/Limit/.test(code)) return t('ai.workspace.files.limit');
    if (/Busy/.test(code)) return t('ai.workspace.files.busy');
    if (/Cancelled|AbortError/.test(code)) return t('ai.workspace.files.cancelled');
    return t('ai.workspace.files.unavailable');
  };
  const readSelection = (element: ComposerEditorHandle) => setSelection([element.selectionStart, element.selectionEnd]);
  const choose = (candidate: FileCandidate, mode: 'select' | 'browse' = 'select') => {
    if (!token || !open || loading) return;
    const next = insertFileMention(text, token, candidate, mode);
    if (!next) return;
    version.current++;
    setResult(null);
    update(next.text);
    setSelection([next.caret, next.caret]);
    requestAnimationFrame(() => {
      if (editor.current?.value === next.text) { editor.current.focus(); editor.current.setSelectionRange(next.caret, next.caret); }
    });
  };
  const confirmRoot = async () => {
    if (!query || binding) return;
    const expected = currentKey.current;
    const abort = new AbortController(); rootAbort.current?.abort(); rootAbort.current = abort;
    setBinding(true); setError(null);
    try {
      const value = await query(queryText, abort.signal, root);
      if (abort.signal.aborted || currentKey.current !== expected) return;
      if (value.status === 'error') { setError(value.code ?? 'Unavailable'); return; }
      setRootOpen(false); setBrowsing(true); setFocused(true); editor.current?.focus();
    } catch (failure) { if (!abort.signal.aborted && currentKey.current === expected) setError(String(failure)); }
    finally { if (!abort.signal.aborted && currentKey.current === expected) setBinding(false); }
  };
  const scope = result?.scope;
  const target = scope?.target;
  const targetName = target ? target.label ?? target.targetId : targetLabel;
  const targetDetails = target?.kind === 'remote'
    ? `${targetName} (${target.username}@${target.host}:${target.port})`
    : targetName;
  const fileSource = target ? `${t(target.kind === 'remote' ? 'ai.workspace.mentions.remoteProject' : 'ai.workspace.mentions.localProject')} · ${targetName}` : targetLabel;
  const foldersOnly = browsing || queryText.includes('/');
  const candidates = (result?.entries ?? []).filter(candidate => !foldersOnly || candidate.kind === 'directory');
  const hasEntries = candidates.length > 0;
  const replaceToken = (replacement: string) => {
    if (!token) return;
    const suffix = text.slice(token.end);
    const inserted = /^\s/u.test(suffix) ? replacement.trimEnd() : replacement;
    const next = text.slice(0, token.start) + inserted + suffix;
    const caret = token.start + inserted.length;
    setDismissed(JSON.stringify([scopeKey, next, caret, caret]));
    update(next);
    setSelection([caret, caret]);
    requestAnimationFrame(() => {
      if (editor.current?.value === next) { editor.current.focus(); editor.current.setSelectionRange(caret, caret); }
    });
  };
  const browse = () => {
    setBrowsing(true); setDismissed(null); setFocused(true);
    if (rootRequired) { setError(null); setRootOpen(true); }
    const start = editor.current?.selectionStart ?? text.length;
    const end = editor.current?.selectionEnd ?? start;
    const active = activeFileToken(text, start, end);
    const next = active ? text : `${text.slice(0, start)}${start && !/\s/u.test(text[start - 1]) ? ' ' : ''}@${text.slice(end)}`;
    const caret = active ? start : next.length - text.slice(end).length;
    if (!active) update(next);
    setSelection([caret, caret]);
    requestAnimationFrame(() => {
      if (!rootRequired && editor.current?.value === next) {
        editor.current.element?.focus({ preventScroll: true });
        editor.current.focus(); editor.current.setSelectionRange(caret, caret);
        setSelection([caret, caret]); setBrowsing(true);
      }
    });
  };
  const normalized = queryText.toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(normalized);
  const menuGroups = useComposerMenuGroups({ agent: Boolean(context?.agent),
    onAddFile: () => { replaceToken(''); context?.onUpload(); },
    onAddFolder: browse,
    onSkill: name => replaceToken(`/${name} `),
  });
  const groups: MentionGroup[] = context ? [
    ...(!browsing ? [
    ...menuGroups.slice(0, -1).map(group => ({ ...group, options: group.options.filter(option => matches(option.label, option.detail ?? '', option.searchText ?? '')) })),
    { label: t('ai.workspace.addMenu.history'), options: normalized && !context.sessionsLoading && !context.sessionsError && context.onSession
      ? (context.sessions ?? []).filter(session => session.id !== context.currentSessionId && !session.archived && isTopLevelAiSession(session, context.sessions ?? []) && matches(session.title))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(session => ({ key: `chat:${session.id}`, label: session.title, detail: t('ai.workspace.addMenu.chat'), icon: <MessageCircleIcon data-icon="inline-start" />,
          choose: () => { replaceToken(`${session.title} `); requestAnimationFrame(() => context.onSession?.(session)); },
        }))
      : normalized && context.sessionsError ? [{ key: 'retry-history', label: t('ai.workspace.addMenu.retry'), icon: <RefreshCwIcon data-icon="inline-start" />, choose: () => context.onRefreshSessions?.() }] : [],
      notice: !normalized ? t(context.agent ? 'ai.workspace.addMenu.mentionSearchHint' : 'ai.workspace.addMenu.searchHistoryHint') : context.sessionsLoading ? t('ai.workspace.addMenu.loading') : undefined,
      showEmptyLabel: !normalized,
    },
    ] satisfies MentionGroup[] : []),
    ...(showFiles ? [{ label: t(foldersOnly ? 'ai.workspace.mentions.folders' : 'ai.workspace.mentions.project'), options: rootRequired
      ? [{ key: 'root', label: t('ai.workspace.files.chooseRoot'), detail: targetLabel, icon: <FolderOpenIcon data-icon="inline-start" />, choose: () => { setError(null); setRootOpen(true); } }]
      : candidates.map(candidate => ({ key: `file:${candidate.path}`, label: `${candidate.path}${candidate.kind === 'directory' ? '/' : ''}`, detail: fileSource, icon: candidate.kind === 'directory' ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />, choose: () => choose(candidate), enterDirectory: candidate.kind === 'directory' ? () => choose(candidate, 'browse') : undefined })),
      notice: <>{loading && <p>{t('ai.workspace.files.loading')}</p>}{error && <p>{errorText(error)}</p>}{result?.status === 'truncated' && <p>{t('ai.workspace.files.truncated')}</p>}{Boolean(result?.excluded) && <p>{t('ai.workspace.files.excluded')}</p>}{result?.status === 'ready' && !hasEntries && <p>{t('ai.workspace.files.empty')}</p>}</>,
    }] : []),
  ] : [];
  const options: readonly MentionOption[] = groups.flatMap(group => group.options);
  const activeIndex = Math.min(index, Math.max(0, options.length - 1));
  const panel = open ? <div className="ai-file-completion flex min-h-0 min-w-0 flex-col" data-file-completion="">
      <PopoverHeader className="shrink-0 gap-1 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle className="flex items-center gap-1">
            <AtSignIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            {t('ai.workspace.files.title')}
          </PopoverTitle>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('common.close')}
            onMouseDown={event => event.preventDefault()} onClick={() => setDismissed(key)}>
            <XIcon />
          </Button>
        </div>
        {targetName && <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" aria-description={targetDetails}>
          <ServerIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{targetName}</span>
        </div>}
        {scope?.root && <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <FolderIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate font-mono">{scope.root}</span>
        </div>}
      </PopoverHeader>
      <div className="flex min-h-14 min-w-0 flex-col overflow-y-auto px-1.5 pb-1.5">
        {rootRequired && <Button type="button" variant="secondary" className="h-auto w-full min-w-0 shrink-0 justify-start gap-1 px-3 py-2"
          aria-label={t('ai.workspace.files.chooseRoot')} aria-describedby={`${id}-root-hint`}
          onMouseDown={event => event.preventDefault()} onClick={() => { setError(null); setRootOpen(true); }}>
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
            <FolderOpenIcon data-icon="inline-start" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left whitespace-normal">
            <span className="text-[13px] leading-5">{t('ai.workspace.files.chooseRoot')}</span>
            <span id={`${id}-root-hint`} className="text-xs leading-5 font-normal text-muted-foreground">{t('ai.workspace.files.chooseRootHint')}</span>
          </span>
          <Kbd aria-hidden="true">↵</Kbd>
        </Button>}
        <div aria-live="polite" role="status" className="shrink-0 px-2 py-2 text-xs leading-5 text-muted-foreground empty:hidden">
          {loading && <span className="flex items-center gap-1"><Spinner />{t('ai.workspace.files.loading')}</span>}
          {error && <AiErrorNotice title={t('ai.workspace.recovery.title')}>{errorText(error)}</AiErrorNotice>}
          {result?.status === 'truncated' && <p>{t('ai.workspace.files.truncated')}</p>}
          {Boolean(result?.excluded) && <p>{t('ai.workspace.files.excluded')}</p>}
          {result?.status === 'ready' && !hasEntries && <EmptyState title={t('ai.workspace.files.empty')} />}
        </div>
        <div id={id} role="listbox" aria-label={t('ai.workspace.files.title')} className="flex min-h-0 min-w-0 shrink-0 flex-col gap-0.5">
          {candidates.map((candidate, i) => {
            const directory = candidate.kind === 'directory';
            const label = `${candidate.path}${directory ? '/' : ''}`;
            const slash = candidate.path.lastIndexOf('/');
            const parent = slash >= 0 ? candidate.path.slice(0, slash + 1) : '';
            const name = candidate.path.slice(slash + 1);
            return <Button key={candidate.path} id={`${id}-${i}`} type="button" role="option" aria-label={label}
              aria-selected={i === index} tabIndex={-1} variant={i === index ? 'secondary' : 'ghost'}
              className="h-auto min-h-10 w-full min-w-0 shrink-0 justify-start gap-1 px-2.5 py-2"
              onMouseEnter={() => setIndex(i)}
              onMouseDown={event => event.preventDefault()} onClick={() => choose(candidate)}>
              {directory ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <span className="truncate text-[13px] leading-4">{name}{directory ? '/' : ''}</span>
                {parent && <span className="truncate text-[11px] leading-4 font-normal text-muted-foreground">{parent}</span>}
              </span>
              {directory ? <ChevronRightIcon aria-hidden="true" data-icon="inline-end" />
                : i === index && <CornerDownLeftIcon aria-hidden="true" data-icon="inline-end" />}
            </Button>;
          })}
        </div>
      </div>
      <Separator />
      <div className="flex shrink-0 flex-col gap-2 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        <p className="flex items-start gap-1"><InfoIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />{t('ai.workspace.files.hint')}</p>
        {hasEntries && <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{t('ai.workspace.files.navigate')}</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>{t('ai.workspace.files.select')}</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd>{t('common.close')}</span>
        </div>}
      </div>
    </div> : null;
  const dialog = <Dialog open={rootOpen} onOpenChange={value => { setRootOpen(value); if (!value) { rootAbort.current?.abort(); setBinding(false); } }}>
      <DialogContent className="w-[calc(100%-2rem)]" finalFocus={() => editor.current?.element ?? null} onClick={event => event.stopPropagation()}>
        <DialogHeader className="pr-6">
          <DialogTitle>{t('ai.workspace.files.chooseRoot')}</DialogTitle>
          {targetLabel && <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <ServerIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 break-all">{targetLabel}</span>
          </div>}
          <DialogDescription>{t('ai.workspace.skills.rootHint')}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`${id}-project-root`}>{t('ai.workspace.skills.root')}</FieldLabel>
          {rootOpen && <ProjectDirectoryInput key={scopeKey} id={`${id}-project-root`} value={root} disabled={binding}
            onChange={setRoot} list={listDirectories} onConfirm={() => void confirmRoot()} />}
        </Field>
        {error && <AiErrorNotice title={t('ai.workspace.recovery.title')}>{errorText(error)}</AiErrorNotice>}
        <DialogFooter className="flex-row justify-end">
          <DialogClose render={<Button variant="outline" />}>{t('common.cancel')}</DialogClose>
          <Button disabled={binding || !root.trim()} onClick={() => void confirmRoot()}>
            {binding && <Spinner data-icon="inline-start" />}
            {t('ai.workspace.files.bind')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
  return { panel: context && open ? <AiMentionPanel id={id} groups={groups} index={activeIndex} onIndexChange={setIndex}
    header={showFiles && (targetDetails || scope?.root) ? <div className="flex min-w-0 items-center gap-1">
      {targetDetails && <span className="max-w-[50%] truncate" title={targetDetails}>{targetDetails}</span>}
      {targetDetails && scope?.root && <span aria-hidden="true" className="shrink-0">·</span>}
      {scope?.root && <span className="min-w-0 flex-1 truncate" title={scope.root}>{scope.root}</span>}
    </div> : undefined}
    empty={!options.length && !loading && !context.sessionsLoading && !error && !context.sessionsError
      && !(showFiles && result?.status === 'ready' && !hasEntries)} /> : panel, dialog, open, editor, browse,
    dismiss: () => setDismissed(key),
    editorProps: {
      ref: editor,
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open && (context ? options[activeIndex] : candidates[index]) ? `${id}-${context ? activeIndex : index}` : undefined,
      onSelectionChange: () => { if (editor.current) readSelection(editor.current); },
      onFocus: () => { setFocused(true); if (editor.current) readSelection(editor.current); },
      onBlur: () => setFocused(false),
    },
    composition: setComposing,
    keyDown: (event: KeyboardEvent): boolean => {
      if (!open || event.isComposing || event.shiftKey || event.metaKey || event.altKey) return false;
      const controlKey = event.ctrlKey ? event.key.toLowerCase() : null;
      if (controlKey !== null && controlKey !== 'n' && controlKey !== 'p') return false;
      const direction = event.ctrlKey
        ? (controlKey === 'n' ? 1 : -1)
        : event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!direction && !['Enter', 'Tab', 'Escape'].includes(event.key)) return false;
      if (context) {
        if (event.key === 'Tab' && !options.length) { setDismissed(key); return false; }
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { setDismissed(key); return true; }
        if (event.repeat && (event.key === 'Enter' || event.key === 'Tab')) return true;
        if (event.key === 'Enter' || event.key === 'Tab') {
          const option = options[activeIndex];
          if (event.key === 'Tab' && option?.enterDirectory) option.enterDirectory();
          else option?.choose();
        }
        else if (options.length) {
          const next = (activeIndex + direction + options.length) % options.length;
          setIndex(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
        return true;
      }
      if (event.key === 'Tab' && !rootRequired && (loading || !hasEntries)) { setDismissed(key); return false; }
      event.preventDefault(); event.stopPropagation();
      if (rootRequired && (event.key === 'Enter' || event.key === 'Tab')) { setError(null); setRootOpen(true); return true; }
      if (event.key === 'Escape') { setDismissed(key); setResult(null); return true; }
      if (event.repeat && (event.key === 'Enter' || event.key === 'Tab')) return true;
      const entries = candidates;
      if (entries.length && !loading) {
        if (event.key === 'Enter' || event.key === 'Tab') choose(entries[index], event.key === 'Tab' ? 'browse' : 'select');
        else {
          const next = (index + direction + entries.length) % entries.length;
          setIndex(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
      }
      return true;
    },
  };
}
