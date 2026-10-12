import React, { useEffect, useId, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { formatTabTitle, resolveTabTitleValues, TAB_TITLE_PRESETS, validTabTitleTemplate } from '@/lib/terminal/tab-title';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function TerminalTitleSettings({ profileId }: { profileId?: string }) {
  const { t } = useI18n();
  const id = useId();
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
  }, [template, scope, templateCustom]);
  const valid = validTabTitleTemplate(draft);
  const presetKeys = ['terminal.title.preset0', 'terminal.title.preset1', 'terminal.title.preset2', 'terminal.title.preset3', 'terminal.title.preset4'] as const;
  const items: { value: string; label: string }[] = TAB_TITLE_PRESETS.map((value, index) => ({ value, label: t(presetKeys[index]) }));
  items.push({ value: 'custom', label: t('terminal.title.custom') });
  const scopeItems = [{ value: '__global__', label: t('terminal.title.global') }, ...profiles.map((profile) => ({ value: profile.id, label: profile.name || profile.host }))];
  const save = (value: string, isCustom = custom) => { if (scope) setOverride(scope, value, isCustom); else setGlobal(value, isCustom); };
  const session = sessions.find((item) => scope ? item.profileId === scope : !item.manualTitle);
  const profile = profiles.find((item) => item.id === (scope || session?.profileId));
  const preview = session || profile ? formatTabTitle(draft, resolveTabTitleValues(session, profile), custom) : null;

  return <FieldGroup className="@container min-w-0 gap-3">
    <FieldGroup className="grid min-w-0 grid-cols-1 gap-3 @min-[28rem]:grid-cols-2" data-title-selects>
    {!profileId && <Field className="min-w-0">
      <FieldLabel htmlFor={`${id}-scope`}>{t('terminal.title.scope')}</FieldLabel>
      <Select items={scopeItems} value={scope || '__global__'} onValueChange={(value) => setScope(value === '__global__' ? '' : value ?? '')}>
        <SelectTrigger id={`${id}-scope`} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{scopeItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </Field>}
    <Field className="min-w-0">
      <FieldLabel htmlFor={`${id}-preset`}>{t('terminal.title.template')}</FieldLabel>
      <Select items={items} value={!custom && TAB_TITLE_PRESETS.some((value) => value === draft) ? draft : 'custom'} onValueChange={(value) => {
        if (value === 'custom') setCustom(true);
        else if (value) { setCustom(false); setDraft(value); save(value, false); }
      }}>
        <SelectTrigger id={`${id}-preset`} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </Field>
    </FieldGroup>
    <Field data-invalid={!valid || undefined}>
      <FieldLabel htmlFor={`${id}-template`}>{t('terminal.title.custom')}</FieldLabel>
      <Input id={`${id}-template`} value={draft} maxLength={256} aria-invalid={!valid} aria-describedby={`${id}-help`} onChange={(event) => { setCustom(true); setDraft(event.target.value); }} onKeyDown={(event) => {
        if (event.key === 'Enter' && valid) { event.preventDefault(); save(draft); }
      }} />
      <FieldDescription id={`${id}-help`}>{t('terminal.title.variables')}</FieldDescription>
      {!valid && <FieldDescription role="alert">{t('terminal.title.invalid')}</FieldDescription>}
    </Field>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3" data-title-actions>
    {preview !== null && <FieldDescription className="min-w-0 flex-1 break-all">{t('terminal.title.preview', { title: preview })}</FieldDescription>}
    <div className="ml-auto flex shrink-0 flex-wrap gap-2">
      <Button size="sm" disabled={!valid || (draft === template && custom === templateCustom && !inheritsGlobal)} onClick={() => save(draft)}>{t('common.save')}</Button>
      {scope && <Button size="sm" variant="outline" disabled={!overrides[scope]} onClick={() => setOverride(scope, null)}>{t('terminal.title.inherit')}</Button>}
    </div>
    </div>
  </FieldGroup>;
}
