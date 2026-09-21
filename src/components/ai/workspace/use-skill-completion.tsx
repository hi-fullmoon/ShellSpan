import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { BookOpenIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AiMentionPanel } from './ai-mention-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { ComposerEditorHandle } from './ai-composer-editor';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import { activeSkillToken, insertSkill } from '@/lib/ai/skill-completion';
import type { SkillEntry, SkillUserList } from '@/types/agent-skill';
import { AiErrorNotice } from './ai-error-notice';

export function useSkillCompletion({ text, update, query, scopeKey, disabled, editor }: {
  text: string; update: (value: string) => void; query?: () => Promise<SkillUserList>;
  scopeKey?: string; disabled: boolean; editor: React.RefObject<ComposerEditorHandle | null>;
}) {
  const { t, locale } = useI18n();
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const cache = useMemo(() => ({
    query, scopeKey, result: null as SkillUserList | null, error: false,
    pending: null as Promise<void> | null, updatedAt: 0,
  }), [query, scopeKey]);
  const [, refresh] = useReducer(value => value + 1, 0);
  const { result, error } = cache;
  const loading = Boolean(query && !result && !error);
  const [index, setIndex] = useState(0);
  const id = useId();
  const knownCommands = useRef({ scopeKey, names: new Set(builtinSkills.map(skill => skill.name)) });
  if (knownCommands.current.scopeKey !== scopeKey) {
    knownCommands.current = { scopeKey, names: new Set(builtinSkills.map(skill => skill.name)) };
  }
  const token = activeSkillToken(text, ...selection);
  const key = JSON.stringify([scopeKey, text, ...selection]);
  useEffect(() => { setDismissed(previous => previous === key ? previous : null); }, [key]);
  const open = Boolean(query && token && focused && !disabled && !composing && dismissed !== key);
  useEffect(() => {
    if (!cache.query || disabled) return;
    // Preload once per scope; reopening within 30 seconds reuses the same result.
    // An expired result remains selectable while its replacement is fetched.
    if (!cache.pending && (!cache.updatedAt || (open && Date.now() - cache.updatedAt >= 30_000))) {
      const request = cache.query;
      cache.pending = Promise.resolve().then(() => request()).then(value => {
        cache.result = value;
        cache.error = false;
      }, () => { cache.error = true; }).finally(() => {
        cache.updatedAt = Date.now();
        cache.pending = null;
      });
    }
    let active = true;
    void cache.pending?.then(() => {
      if (!active) return;
      cache.result?.entries.filter(skill => skill.userInvocable).forEach(skill => knownCommands.current.names.add(skill.name));
      refresh();
    });
    return () => { active = false; };
  }, [open, cache, disabled]);
  const description = (skill: SkillEntry): string => locale === 'zh-CN' && skill.resourceBase === 'builtin'
    ? builtinSkills.find(item => item.name === skill.name)?.descriptionZh ?? skill.description
    : skill.description;
  const entries = result?.entries.filter(skill => skill.userInvocable &&
    `${skill.name} ${skill.description} ${description(skill)}`.toLowerCase().includes(token?.query ?? '')) ?? [];
  useEffect(() => { setIndex(0); }, [key, result]);
  const readSelection = (element: ComposerEditorHandle) => setSelection([element.selectionStart, element.selectionEnd]);
  const choose = (skill: SkillEntry) => {
    if (!token || !open || loading) return;
    const next = insertSkill(text, token, skill.name);
    setDismissed(JSON.stringify([scopeKey, next.text, next.caret, next.caret]));
    update(next.text);
    setSelection([next.caret, next.caret]);
    requestAnimationFrame(() => {
      if (editor.current?.value === next.text) {
        editor.current.focus(); editor.current.setSelectionRange(next.caret, next.caret);
        // The controlled value update briefly moves the caret to the draft's end,
        // clearing dismissal. Keep the selected skill closed when restoring its caret.
        setDismissed(JSON.stringify([scopeKey, next.text, next.caret, next.caret]));
      }
    });
  };
  const panel = open ? <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-skill-completion="">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="status" aria-live="polite" className="shrink-0 px-2 pt-2 empty:hidden">
        {(error || result?.status === 'unavailable') && <AiErrorNotice title={t('ai.workspace.recovery.title')}>{t('ai.workspace.skills.unavailable')}</AiErrorNotice>}
        {result?.status === 'stale' && <Alert><AlertDescription>{t('ai.workspace.skills.stale')}</AlertDescription></Alert>}
        {result && !loading && result.status !== 'unavailable' && entries.length === 0 && <EmptyState title={t('ai.workspace.skills.noMatch')} />}
      </div>
      <AiMentionPanel id={id} label={t('ai.workspace.skills.title')} index={index} onIndexChange={setIndex} empty={false}
        groups={[{ label: t('ai.workspace.skills.title'), showEmptyLabel: true,
          notice: loading ? <span className="flex items-center gap-1"><Spinner />{t('ai.workspace.skills.loading')}</span> : undefined,
          options: entries.map(skill => ({
          key: `skill:${skill.name}`, label: description(skill), detail: `/${skill.name}`, accessibleLabel: `/${skill.name}`,
          icon: <BookOpenIcon />, choose: () => choose(skill),
        })) }]} />
    </div>
  </div> : null;
  return {
    panel, open,
    dismiss: () => setDismissed(key),
    commandNames: [...knownCommands.current.names],
    editorProps: {
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open && entries[index] ? `${id}-${index}` : undefined,
      onSelectionChange: () => { if (editor.current) readSelection(editor.current); },
      onFocus: () => { setFocused(true); if (editor.current) readSelection(editor.current); },
      onBlur: () => setFocused(false),
    },
    composition: setComposing,
    keyDown: (event: KeyboardEvent): boolean => {
      if (!open || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
      if (event.key === 'Tab' && (loading || !entries.length)) { setDismissed(key); return false; }
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { setDismissed(key); return true; }
      if (event.repeat && (event.key === 'Enter' || event.key === 'Tab')) return true;
      if (entries.length && !loading) {
        if (event.key === 'Enter' || event.key === 'Tab') choose(entries[index] ?? entries[0]);
        else {
          const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
          setIndex(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
      }
      return true;
    },
  };
}
