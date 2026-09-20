import { useEffect, useId, useRef, useState } from 'react';
import { AtSignIcon, BookOpenIcon, ChevronRightIcon, CornerDownLeftIcon, FileIcon, FolderIcon, FolderOpenIcon, InfoIcon, MessageCircleIcon, PaperclipIcon, RefreshCwIcon, ServerIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
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
import { AiProjectDirectoryInput } from './ai-project-directory-input';
import { AiMentionPanel, type MentionContext, type MentionGroup, type MentionOption } from './ai-mention-panel';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import { isTopLevelAiSession } from '@/lib/ai/session-list';

export function useFileCompletion({ text, update, query, scopeKey, needsRoot, targetLabel, disabled, context }: {
  text: string; update: (value: string) => void; query?: ListFileReferences; scopeKey?: string;
  needsRoot?: boolean; targetLabel?: string; disabled: boolean;
  context?: MentionContext;
}) {
  const { t, locale } = useI18n();
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
  const choose = (candidate: FileCandidate) => {
    if (!token || !open || loading) return;
    const next = insertFileMention(text, token, candidate);
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
  const hasEntries = Boolean(result?.entries.length);
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
    const start = editor.current?.selectionStart ?? text.length;
    const end = editor.current?.selectionEnd ?? start;
    const active = activeFileToken(text, start, end);
    const next = active ? text : `${text.slice(0, start)}${start && !/\s/u.test(text[start - 1]) ? ' ' : ''}@${text.slice(end)}`;
    const caret = active ? start : next.length - text.slice(end).length;
    if (!active) update(next);
    setSelection([caret, caret]);
    requestAnimationFrame(() => { if (editor.current?.value === next) { editor.current.focus(); editor.current.setSelectionRange(caret, caret); } });
  };
  const normalized = queryText.toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(normalized);
  const groups: MentionGroup[] = context ? [
    { label: t('ai.workspace.addMenu.add'), options: [
      ...(matches(t('ai.workspace.mentions.upload'), t('ai.workspace.addMenu.fileHint')) ? [{ key: 'upload', label: t('ai.workspace.mentions.upload'), detail: t('ai.workspace.mentions.localAttachment'), icon: <PaperclipIcon data-icon="inline-start" />, choose: () => { replaceToken(''); context.onUpload(); } }] : []),
      ...(query && matches(t('ai.workspace.mentions.project'), targetLabel ?? '') ? [{ key: 'project', label: t('ai.workspace.mentions.project'), detail: targetLabel, icon: <FolderOpenIcon data-icon="inline-start" />, choose: () => { setBrowsing(true); if (needsRoot) { setError(null); setRootOpen(true); } } }] : []),
    ] },
    ...(context.agent ? [{ label: t('ai.workspace.skills.title'), options: builtinSkills.filter(skill => matches(skill.name, skill.description, skill.descriptionZh)).map(skill => ({
      key: `skill:${skill.name}`, label: locale === 'zh-CN' ? skill.descriptionZh : skill.description, detail: `/${skill.name}`, icon: <BookOpenIcon data-icon="inline-start" />,
      choose: () => replaceToken(`/${skill.name} `),
    })) }] : []),
    { label: t('ai.workspace.addMenu.history'), options: normalized && !context.sessionsLoading && !context.sessionsError && context.onSession
      ? (context.sessions ?? []).filter(session => session.id !== context.currentSessionId && !session.archived && isTopLevelAiSession(session, context.sessions ?? []) && matches(session.title))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(session => ({ key: `chat:${session.id}`, label: session.title, detail: t('ai.workspace.addMenu.chat'), icon: <MessageCircleIcon data-icon="inline-start" />,
          choose: () => { replaceToken(''); requestAnimationFrame(() => context.onSession?.(session)); },
        }))
      : normalized && context.sessionsError ? [{ key: 'retry-history', label: t('ai.workspace.addMenu.retry'), icon: <RefreshCwIcon data-icon="inline-start" />, choose: () => context.onRefreshSessions?.() }] : [],
      notice: !normalized ? t(context.agent ? 'ai.workspace.addMenu.mentionSearchHint' : 'ai.workspace.addMenu.searchHistoryHint') : context.sessionsLoading ? t('ai.workspace.addMenu.loading') : undefined,
    },
    ...(showFiles ? [{ label: t('ai.workspace.mentions.project'), options: needsRoot
      ? [{ key: 'root', label: t('ai.workspace.files.chooseRoot'), detail: targetLabel, icon: <FolderOpenIcon data-icon="inline-start" />, choose: () => { setError(null); setRootOpen(true); } }]
      : (result?.entries ?? []).map(candidate => ({ key: `file:${candidate.path}`, label: `${candidate.path}${candidate.kind === 'directory' ? '/' : ''}`, detail: fileSource, icon: candidate.kind === 'directory' ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />, choose: () => choose(candidate) })),
      notice: <>{targetDetails && <p>{targetDetails}</p>}{scope?.root && <p className="break-all">{scope.root}</p>}{loading && <p>{t('ai.workspace.files.loading')}</p>}{error && <p>{errorText(error)}</p>}{result?.status === 'truncated' && <p>{t('ai.workspace.files.truncated')}</p>}{Boolean(result?.excluded) && <p>{t('ai.workspace.files.excluded')}</p>}{result?.status === 'ready' && !hasEntries && <p>{t('ai.workspace.files.empty')}</p>}</>,
    }] : []),
  ] : [];
  const options: readonly MentionOption[] = groups.flatMap(group => group.options);
  const activeIndex = Math.min(index, Math.max(0, options.length - 1));
  const panel = open ? <div className="ai-file-completion flex min-h-0 min-w-0 flex-col" data-file-completion="">
      <PopoverHeader className="shrink-0 gap-1 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle className="flex items-center gap-2">
            <AtSignIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            {t('ai.workspace.files.title')}
          </PopoverTitle>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('common.close')}
            onMouseDown={event => event.preventDefault()} onClick={() => setDismissed(key)}>
            <XIcon />
          </Button>
        </div>
        {targetName && <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={targetDetails}>
          <ServerIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{targetName}</span>
        </div>}
        {scope?.root && <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={scope.root}>
          <FolderIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate font-mono">{scope.root}</span>
        </div>}
      </PopoverHeader>
      <div className="flex min-h-14 min-w-0 flex-col overflow-y-auto px-1.5 pb-1.5">
        {needsRoot && <Button type="button" variant="secondary" className="h-auto w-full min-w-0 shrink-0 justify-start gap-1 px-3 py-2"
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
          {loading && <span className="flex items-center gap-2"><Spinner />{t('ai.workspace.files.loading')}</span>}
          {error && <AiErrorNotice title={t('ai.workspace.recovery.title')}>{errorText(error)}</AiErrorNotice>}
          {result?.status === 'truncated' && <p>{t('ai.workspace.files.truncated')}</p>}
          {Boolean(result?.excluded) && <p>{t('ai.workspace.files.excluded')}</p>}
          {result?.status === 'ready' && result.entries.length === 0 && <EmptyState title={t('ai.workspace.files.empty')} />}
        </div>
        <div id={id} role="listbox" aria-label={t('ai.workspace.files.title')} className="flex min-h-0 min-w-0 shrink-0 flex-col gap-0.5">
          {result?.entries.map((candidate, i) => {
            const directory = candidate.kind === 'directory';
            const label = `${candidate.path}${directory ? '/' : ''}`;
            const slash = candidate.path.lastIndexOf('/');
            const parent = slash >= 0 ? candidate.path.slice(0, slash + 1) : '';
            const name = candidate.path.slice(slash + 1);
            return <Button key={candidate.path} id={`${id}-${i}`} type="button" role="option" aria-label={label}
              aria-selected={i === index} tabIndex={-1} variant={i === index ? 'secondary' : 'ghost'}
              className="h-auto min-h-10 w-full min-w-0 shrink-0 justify-start gap-1 px-2.5 py-2"
              title={label} onMouseDown={event => event.preventDefault()} onClick={() => choose(candidate)}>
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
        <p className="flex items-start gap-1.5"><InfoIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />{t('ai.workspace.files.hint')}</p>
        {hasEntries && <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{t('ai.workspace.files.navigate')}</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>{t('ai.workspace.files.select')}</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd>{t('common.close')}</span>
        </div>}
      </div>
    </div> : null;
  const dialog = <Dialog open={rootOpen} onOpenChange={value => { setRootOpen(value); if (!value) { rootAbort.current?.abort(); setBinding(false); } }}>
      <DialogContent finalFocus={() => editor.current?.element ?? null} onClick={event => event.stopPropagation()}>
        <DialogTitle>{t('ai.workspace.files.chooseRoot')}</DialogTitle>
        <DialogDescription className="break-all">{targetLabel}</DialogDescription>
        <AiProjectDirectoryInput value={root} onChange={setRoot} onConfirm={() => void confirmRoot()} loading={binding} actionLabel={t('ai.workspace.files.bind')} />
        {error && <AiErrorNotice title={t('ai.workspace.recovery.title')}>{errorText(error)}</AiErrorNotice>}
      </DialogContent>
    </Dialog>;
  return { panel: context && open ? <AiMentionPanel id={id} groups={groups} index={activeIndex} empty={!options.length && !loading && !context.sessionsLoading && !error && !context.sessionsError} /> : panel, dialog, open, editor, browse,
    dismiss: () => setDismissed(key),
    editorProps: {
      ref: editor,
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open && (context ? options[activeIndex] : result?.entries[index]) ? `${id}-${context ? activeIndex : index}` : undefined,
      onSelectionChange: () => { if (editor.current) readSelection(editor.current); },
      onFocus: () => { setFocused(true); if (editor.current) readSelection(editor.current); },
      onBlur: () => setFocused(false),
    },
    composition: setComposing,
    keyDown: (event: KeyboardEvent): boolean => {
      if (!open || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
      if (context) {
        if (event.key === 'Tab' && !options.length) { setDismissed(key); return false; }
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { setDismissed(key); return true; }
        if (event.repeat && (event.key === 'Enter' || event.key === 'Tab')) return true;
        if (event.key === 'Enter' || event.key === 'Tab') options[activeIndex]?.choose();
        else if (options.length) {
          const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          setIndex(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
        return true;
      }
      if (event.key === 'Tab' && !needsRoot && (loading || !result?.entries.length)) { setDismissed(key); return false; }
      event.preventDefault(); event.stopPropagation();
      if (needsRoot && (event.key === 'Enter' || event.key === 'Tab')) { setError(null); setRootOpen(true); return true; }
      if (event.key === 'Escape') { setDismissed(key); setResult(null); return true; }
      if (event.repeat && (event.key === 'Enter' || event.key === 'Tab')) return true;
      const entries = result?.entries ?? [];
      if (entries.length && !loading) {
        if (event.key === 'Enter' || event.key === 'Tab') choose(entries[index]);
        else {
          const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
          setIndex(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
      }
      return true;
    },
  };
}
