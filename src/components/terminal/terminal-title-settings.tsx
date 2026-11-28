import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { formatTabTitle, resolveTabTitleValues, TAB_TITLE_PRESETS, validTabTitleTemplate } from '@/lib/terminal/tab-title';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface TemplateVariableHint {
  token: string;
  label: string;
}

const TEMPLATE_VARIABLES = ['name', 'user', 'host', 'port', 'index', 'cwd', 'title'] as const;

function parseVariableHints(helpText: string): { prefix: string; items: TemplateVariableHint[] } | null {
  const separatorMatch = helpText.match(/^([^$]+?[:：])\s*(.+)$/);
  if (!separatorMatch) return null;
  const prefix = separatorMatch[1].replace(/[:：]\s*$/, '').trim();
  const body = separatorMatch[2].replace(/[。.]\s*$/, '');
  const items: TemplateVariableHint[] = [];
  const tokenPattern = /\$\{(name|user|host|port|index|cwd|title)\}\s*([^、,]+)/g;
  for (const match of body.matchAll(tokenPattern)) {
    items.push({ token: `\${${match[1]}}`, label: match[2].trim() });
  }
  if (items.length !== TEMPLATE_VARIABLES.length) return null;
  return { prefix, items };
}

export function TerminalTitleSettings({ profileId }: { profileId?: string }) {
  const { t } = useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const globalTemplate = useAppStore((state) => state.terminalTabTitleTemplate);
  const overrides = useAppStore((state) => state.terminalTabTitleOverrides);
  const globalCustom = useAppStore((state) => state.terminalTabTitleCustom);
  const customOverrides = useAppStore((state) => state.terminalTabTitleCustomOverrides);
  const setGlobal = useAppStore((state) => state.setTerminalTabTitleTemplate);
  const setOverride = useAppStore((state) => state.setTerminalTabTitleOverride);
  const profiles = useProfileStore((state) => state.profiles);
  const sessions = useTerminalStore((state) => state.sessions);
  const [scope, setScope] = useState(profileId ?? '');
  const template = (scope && overrides[scope]) || globalTemplate;
  const inheritsGlobal = Boolean(scope) && overrides[scope] === undefined;
  const templateCustom = scope && !inheritsGlobal ? customOverrides[scope] === true : globalCustom;
  const [draft, setDraft] = useState(template);
  const [custom, setCustom] = useState(templateCustom || !TAB_TITLE_PRESETS.some((value) => value === template));
  useEffect(() => {
    setDraft(template);
    setCustom(templateCustom || !TAB_TITLE_PRESETS.some((value) => value === template));
    selectionRef.current = null;
  }, [template, scope, templateCustom]);
  const valid = validTabTitleTemplate(draft);
  const presetKeys = ['terminal.title.preset0', 'terminal.title.preset1', 'terminal.title.preset2', 'terminal.title.preset3', 'terminal.title.preset4', 'terminal.title.preset5', 'terminal.title.preset6'] as const;
  const items: { value: string; label: string }[] = TAB_TITLE_PRESETS.map((value, index) => ({ value, label: t(presetKeys[index]) }));
  items.push({ value: 'custom', label: t('terminal.title.custom') });
  const scopeItems = [{ value: '__global__', label: t('terminal.title.global') }, ...profiles.map((profile) => ({ value: profile.id, label: profile.name || profile.host }))];
  const save = (value: string, isCustom = custom) => { if (scope) setOverride(scope, value, isCustom); else setGlobal(value, isCustom); };
  const session = sessions.find((item) => scope ? item.profileId === scope : !item.manualTitle);
  const profile = profiles.find((item) => item.id === (scope || session?.profileId));
  const preview = session || profile ? formatTabTitle(draft, resolveTabTitleValues(session, profile), custom) : null;
  const variableHelpText = t('terminal.title.variables');
  const parsedVariables = useMemo(() => parseVariableHints(variableHelpText), [variableHelpText]);

  const applyDraft = (value: string) => {
    setCustom(true);
    setDraft(value);
    if (validTabTitleTemplate(value)) save(value, true);
  };

  const syncSelection = (target: HTMLInputElement) => {
    if (target.selectionStart !== null && target.selectionEnd !== null) {
      selectionRef.current = { start: target.selectionStart, end: target.selectionEnd };
    }
  };

  const insertVariable = (token: string) => {
    const input = inputRef.current;
    const selection = selectionRef.current;
    if (selection) {
      const start = Math.max(0, Math.min(selection.start, draft.length));
      const end = Math.max(start, Math.min(selection.end, draft.length));
      if (draft.length - (end - start) + token.length > 256) return;
      const nextValue = `${draft.slice(0, start)}${token}${draft.slice(end)}`;
      const cursor = start + token.length;
      selectionRef.current = { start: cursor, end: cursor };
      applyDraft(nextValue);
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(cursor, cursor);
      });
      return;
    }
    const separator = draft.length > 0 && !/\s$/.test(draft) ? ' ' : '';
    const addition = `${separator}${token}`;
    if (draft.length + addition.length > 256) return;
    const nextValue = `${draft}${addition}`;
    const cursor = nextValue.length;
    selectionRef.current = { start: cursor, end: cursor };
    applyDraft(nextValue);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <FieldGroup className="@container flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <FieldLabel className="text-sm font-medium text-foreground">{t('terminal.title.template')}</FieldLabel>
          <FieldDescription>{t('terminal.title.description')}</FieldDescription>
        </div>
        <div
          className="-ml-2 flex min-w-0 flex-col items-start gap-1 @min-[28rem]:flex-row @min-[28rem]:items-center @min-[28rem]:gap-1.5 @min-[32rem]:ml-0 @min-[32rem]:shrink-0 @min-[32rem]:justify-end"
          data-title-selects
        >
          {!profileId && (
            <Select items={scopeItems} value={scope || '__global__'} onValueChange={(value) => setScope(value === '__global__' ? '' : value ?? '')}>
              <SelectTrigger id={`${id}-scope`} variant="ghost" size="sm" aria-label={t('terminal.title.scope')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>{scopeItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
              </SelectContent>
            </Select>
          )}
          {!profileId && <span aria-hidden="true" className="hidden h-3.5 w-px shrink-0 bg-border/60 @min-[28rem]:block" />}
          <Select items={items} value={!custom && TAB_TITLE_PRESETS.some((value) => value === draft) ? draft : 'custom'} onValueChange={(value) => {
            if (value === 'custom') { setCustom(true); if (valid) save(draft, true); }
            else if (value) { setCustom(false); setDraft(value); save(value, false); }
          }}>
            <SelectTrigger id={`${id}-preset`} variant="ghost" size="sm" aria-label={t('terminal.title.template')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              <SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border-[0.5px] border-border/50 bg-muted/30 p-3 dark:bg-background/50">
        <Field className="gap-2" data-invalid={!valid || undefined}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-title-actions>
            <FieldLabel htmlFor={`${id}-template`} className="text-xs font-medium text-muted-foreground">
              {t('terminal.title.custom')}
            </FieldLabel>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {preview !== null && (
                <span className="inline-flex max-w-full items-center rounded-md border-[0.5px] border-border/50 bg-card px-2 py-0.5 text-xs text-foreground break-all">
                  {t('terminal.title.preview', { title: preview })}
                </span>
              )}
              {scope && (
                <Button size="sm" variant="soft" disabled={!overrides[scope]} onClick={() => setOverride(scope, null)}>
                  {t('terminal.title.inherit')}
                </Button>
              )}
            </div>
          </div>
          <Input
            ref={inputRef}
            id={`${id}-template`}
            className="h-8 rounded-lg border-border/60 bg-card font-mono text-xs"
            value={draft}
            maxLength={256}
            aria-invalid={!valid}
            aria-describedby={`${id}-help`}
            onSelect={(event) => syncSelection(event.currentTarget)}
            onBlur={(event) => syncSelection(event.currentTarget)}
            onChange={(event) => {
              syncSelection(event.currentTarget);
              applyDraft(event.target.value);
            }}
          />
          {!valid && <FieldDescription role="alert" className="text-destructive">{t('terminal.title.invalid')}</FieldDescription>}
          {parsedVariables ? (
            <div id={`${id}-help`} className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-xs text-muted-foreground">{parsedVariables.prefix}</span>
              {parsedVariables.items.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  title={item.label}
                  onClick={() => insertVariable(item.token)}
                  className="inline-flex items-center gap-1 rounded-md border-[0.5px] border-border/50 bg-card px-1.5 py-0.5 text-xs leading-4 text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <code className="font-mono text-[11px] text-foreground">{item.token}</code>
                  <span className="text-[11px]">{item.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <FieldDescription id={`${id}-help`}>{variableHelpText}</FieldDescription>
          )}
        </Field>
      </div>
    </FieldGroup>
  );
}
