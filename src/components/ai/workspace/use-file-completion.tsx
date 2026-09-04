import { useEffect, useId, useRef, useState } from 'react';
import { FileIcon, FolderIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { activeFileToken, insertFileMention } from '@/lib/ai/file-reference-grammar';
import type { FileCandidate, FileReferenceList, ListFileReferences } from '@/types/agent-file-reference';
import { AiProjectDirectoryInput } from './ai-project-directory-input';

export function useFileCompletion({ text, update, query, scopeKey, needsRoot, targetLabel, disabled }: {
  text: string; update: (value: string) => void; query?: ListFileReferences; scopeKey?: string;
  needsRoot?: boolean; targetLabel?: string; disabled: boolean;
}) {
  const { t } = useI18n();
  const editor = useRef<HTMLTextAreaElement>(null);
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
  const rootAbort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const id = useId();
  const token = activeFileToken(text, ...selection);
  const key = JSON.stringify([scopeKey, text, ...selection]);
  const currentKey = useRef(key); currentKey.current = key;
  // Dismiss only this visit to the token. Editing away must retire the old key,
  // otherwise returning to identical text keeps its list hidden indefinitely.
  useEffect(() => { setDismissed(previous => previous === key ? previous : null); }, [key]);
  const open = Boolean(query && token && !disabled && !composing && focused && dismissed !== key);
  const queryText = token?.query ?? '';
  useEffect(() => {
    const generation = ++version.current;
    const abort = new AbortController();
    setResult(null); setError(null); setIndex(0); setLoading(false);
    if (!open || needsRoot || rootOpen || !query) return () => { abort.abort(); version.current++; };
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
  }, [key, open, query, queryText, needsRoot, rootOpen]);
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
  const readSelection = (element: HTMLTextAreaElement) => setSelection([element.selectionStart, element.selectionEnd]);
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
      setRootOpen(false); setFocused(true); editor.current?.focus();
    } catch (failure) { if (!abort.signal.aborted && currentKey.current === expected) setError(String(failure)); }
    finally { if (!abort.signal.aborted && currentKey.current === expected) setBinding(false); }
  };
  const panel = open ? <Card size="sm" className="w-full min-w-0" data-file-completion="">
      <CardHeader>
        <CardTitle>{t('ai.workspace.files.title')}</CardTitle>
        <CardDescription className="break-all">{result?.scope ? `${result.scope.target.label ?? result.scope.target.targetId} (${result.scope.target.kind === 'local' ? 'local' : `${result.scope.target.username}@${result.scope.target.host}:${result.scope.target.port}`}) · ${result.scope.root}` : targetLabel}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t('ai.workspace.files.hint')}</p>
        {needsRoot && <p>{t('ai.workspace.files.rootKeyboard')}</p>}
        {needsRoot && <Button type="button" variant="outline" onMouseDown={e => e.preventDefault()} onClick={() => { setError(null); setRootOpen(true); }}>{t('ai.workspace.files.chooseRoot')}</Button>}
        <div aria-live="polite" role="status">
          {loading && <span className="flex items-center gap-2"><Spinner />{t('ai.workspace.files.loading')}</span>}
          {error && <Alert><AlertDescription>{errorText(error)}</AlertDescription></Alert>}
          {result?.status === 'truncated' && <p>{t('ai.workspace.files.truncated')}</p>}
          {Boolean(result?.excluded) && <p>{t('ai.workspace.files.excluded')}</p>}
          {result?.status === 'ready' && result.entries.length === 0 && <EmptyState title={t('ai.workspace.files.empty')} />}
        </div>
        <div id={id} role="listbox" aria-label={t('ai.workspace.files.title')} className="flex max-h-40 min-w-0 flex-col gap-1 overflow-y-auto">
          {result?.entries.map((candidate, i) => <Button key={candidate.path} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1} variant={i === index ? 'secondary' : 'ghost'} className="w-full min-w-0 justify-start" onMouseDown={e => e.preventDefault()} onClick={() => choose(candidate)}>
            {candidate.kind === 'directory' ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />}
            <span className="truncate" title={candidate.path}>{candidate.path}{candidate.kind === 'directory' ? '/' : ''}</span>
          </Button>)}
        </div>
      </CardContent>
    </Card> : null;
  const dialog = <Dialog open={rootOpen} onOpenChange={value => { setRootOpen(value); if (!value) { rootAbort.current?.abort(); setBinding(false); } }}>
      <DialogContent finalFocus={editor} onClick={event => event.stopPropagation()}>
        <DialogTitle>{t('ai.workspace.files.chooseRoot')}</DialogTitle>
        <DialogDescription className="break-all">{targetLabel}</DialogDescription>
        <AiProjectDirectoryInput value={root} onChange={setRoot} onConfirm={() => void confirmRoot()} loading={binding} actionLabel={t('ai.workspace.files.bind')} />
        {error && <Alert><AlertDescription>{errorText(error)}</AlertDescription></Alert>}
      </DialogContent>
    </Dialog>;
  return { panel, dialog, open, editor,
    textareaProps: {
      ref: editor,
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open && result?.entries[index] ? `${id}-${index}` : undefined,
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => readSelection(event.currentTarget),
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => { setFocused(true); readSelection(event.currentTarget); },
      onBlur: () => setFocused(false),
    },
    changed: readSelection,
    composition: setComposing,
    keyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
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
