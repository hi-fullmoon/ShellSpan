import { useEffect, useId, useRef, useState } from 'react';
import { BookOpenIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import { activeSkillToken, insertSkill } from '@/lib/ai/skill-completion';
import type { SkillEntry, SkillUserList } from '@/types/agent-skill';

export function useSkillCompletion({ text, update, query, scopeKey, disabled, editor }: {
  text: string; update: (value: string) => void; query?: () => Promise<SkillUserList>;
  scopeKey?: string; disabled: boolean; editor: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t, locale } = useI18n();
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<SkillUserList | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const id = useId();
  const version = useRef(0);
  const token = activeSkillToken(text, ...selection);
  const key = JSON.stringify([scopeKey, text, ...selection]);
  useEffect(() => { setDismissed(previous => previous === key ? previous : null); }, [key]);
  const open = Boolean(query && token && focused && !disabled && !composing && dismissed !== key);
  useEffect(() => {
    const generation = ++version.current;
    setResult(null); setError(false); setLoading(false);
    if (!open || !query) return;
    setLoading(true);
    void query().then(value => {
      if (generation === version.current) { setResult(value); setLoading(false); }
    }, () => {
      if (generation === version.current) { setError(true); setLoading(false); }
    });
    return () => { version.current++; };
  }, [open, query, scopeKey]);
  const description = (skill: SkillEntry): string => locale === 'zh-CN' && skill.resourceBase === 'builtin'
    ? builtinSkills.find(item => item.name === skill.name)?.descriptionZh ?? skill.description
    : skill.description;
  const entries = result?.entries.filter(skill => skill.userInvocable &&
    `${skill.name} ${skill.description} ${description(skill)}`.toLowerCase().includes(token?.query ?? '')) ?? [];
  useEffect(() => { setIndex(0); }, [key, result]);
  const readSelection = (element: HTMLTextAreaElement) => setSelection([element.selectionStart, element.selectionEnd]);
  const choose = (skill: SkillEntry) => {
    if (!token || !open || loading) return;
    const next = insertSkill(text, token, skill.name);
    setDismissed(JSON.stringify([scopeKey, next.text, next.caret, next.caret]));
    update(next.text);
    setSelection([next.caret, next.caret]);
    requestAnimationFrame(() => {
      if (editor.current?.value === next.text) {
        editor.current.focus(); editor.current.setSelectionRange(next.caret, next.caret);
      }
    });
  };
  const panel = open ? <Card size="sm" className="w-full min-w-0" data-skill-completion="">
    <CardHeader>
      <CardTitle>{t('ai.workspace.skills.title')}</CardTitle>
      <CardDescription>{t('ai.workspace.skills.hint')}</CardDescription>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-2">
      <div role="status" aria-live="polite">
        {loading && <span className="flex items-center gap-2"><Spinner />{t('ai.workspace.skills.loading')}</span>}
        {(error || result?.status === 'unavailable') && <Alert><AlertDescription>{t('ai.workspace.skills.unavailable')}</AlertDescription></Alert>}
        {result?.status === 'stale' && <Alert><AlertDescription>{t('ai.workspace.skills.stale')}</AlertDescription></Alert>}
        {result && !loading && result.status !== 'unavailable' && entries.length === 0 && <EmptyState title={t('ai.workspace.skills.noMatch')} />}
      </div>
      <div id={id} role="listbox" aria-label={t('ai.workspace.skills.title')} className="flex max-h-60 min-w-0 flex-col gap-1 overflow-y-auto">
        {entries.map((skill, i) => <Button key={skill.name} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
          variant={i === index ? 'secondary' : 'ghost'} className="h-auto w-full min-w-0 justify-start py-2" onMouseDown={event => event.preventDefault()} onClick={() => choose(skill)}>
          <BookOpenIcon data-icon="inline-start" />
          <span className="flex min-w-0 flex-col items-start gap-1 text-left">
            <span className="truncate">/{skill.name}</span>
            <span className="whitespace-normal break-words text-xs text-muted-foreground">{description(skill)}</span>
          </span>
        </Button>)}
      </div>
    </CardContent>
  </Card> : null;
  return {
    panel, open,
    textareaProps: {
      'aria-controls': open ? id : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open && entries[index] ? `${id}-${index}` : undefined,
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => readSelection(event.currentTarget),
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => { setFocused(true); readSelection(event.currentTarget); },
      onBlur: () => setFocused(false),
    },
    changed: readSelection,
    composition: setComposing,
    keyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
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
