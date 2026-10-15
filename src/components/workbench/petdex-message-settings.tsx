import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, FlaskConicalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingRow } from './settings-layout';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { getPetdexMessageDiagnostic, testPetdexMessage } from '@/lib/petdex/messages';
import type { PetdexMessagePreferences } from '@/lib/petdex/message-preferences';

export function PetdexMessageSettings() {
  const { t, locale } = useI18n();
  const enabled = useAppStore((s) => s.petdexEnabled);
  const messagesEnabled = useAppStore((s) => s.petdexRequestedMessages?.petdexMessagesEnabled ?? s.petdexMessagesEnabled);
  const detailsEnabled = useAppStore((s) => s.petdexRequestedMessages?.petdexMessageDetailsEnabled ?? s.petdexMessageDetailsEnabled);
  const configuring = useAppStore((s) => s.petdexConfiguring);
  const configurationFailed = useAppStore((s) => s.petdexConfigurationFailed);
  const diagnostic = useAppStore((s) => s.petdexMessageDiagnostic);
  const [testing, setTesting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await getPetdexMessageDiagnostic();
        if (!cancelled) {
          useAppStore.getState().receivePetdexMessageDiagnostic(snapshot);
          setUnavailable(false);
        }
      } catch { if (!cancelled) setUnavailable(true); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; mounted.current = false; clearInterval(timer); };
  }, []);
  const update = async (key: keyof PetdexMessagePreferences, value: boolean) => {
    try {
      await useAppStore.getState().setPetdexMessagePreference(key, value);
      if (mounted.current) toast(t('settings.experimental.petdex.messages.saved'));
    } catch {
      if (mounted.current) toast.error(t('settings.experimental.petdex.messages.saveFailed'));
    }
  };
  const test = async () => {
    if (busy.current) return;
    busy.current = true;
    setTesting(true);
    try {
      const result = await testPetdexMessage();
      useAppStore.getState().receivePetdexMessageDiagnostic(result.diagnostic);
      if (mounted.current) toast(t(`settings.experimental.petdex.messages.test.${result.outcome}`));
    } catch {
      if (mounted.current) toast.error(t('settings.experimental.petdex.operationError'));
    } finally {
      busy.current = false;
      if (mounted.current) setTesting(false);
    }
  };
  return <>
      <SettingRow controlId="petdex-messages-enabled" label={t('settings.experimental.petdex.messages.enabled')} descriptionId="petdex-message-description" description={t('settings.experimental.petdex.messages.description')}>
          <Switch id="petdex-messages-enabled" aria-label={t('settings.experimental.petdex.messages.enabled')} checked={messagesEnabled} aria-busy={configuring} aria-describedby="petdex-message-description petdex-message-visibility" onCheckedChange={(value) => void update('petdexMessagesEnabled', value)} />
      </SettingRow>
      <Separator />
      <SettingRow controlId="petdex-message-details-enabled" label={t('settings.experimental.petdex.messages.details')} descriptionId="petdex-message-risk" description={t('settings.experimental.petdex.messages.risk')}>
          <Switch id="petdex-message-details-enabled" aria-label={t('settings.experimental.petdex.messages.details')} checked={detailsEnabled} aria-busy={configuring} aria-describedby="petdex-message-risk" onCheckedChange={(value) => void update('petdexMessageDetailsEnabled', value)} />
      </SettingRow>
      <Separator />
    <div className="flex min-w-0 flex-col gap-3 px-3.5 py-3">
      <p id="petdex-message-visibility" className="text-xs leading-relaxed text-muted-foreground">{t('settings.experimental.petdex.messages.visibility')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" type="button" disabled={!enabled || !messagesEnabled || configuring || testing} onClick={() => void test()}>
          <FlaskConicalIcon data-icon="inline-start" />{t(testing ? 'settings.experimental.petdex.testing' : 'settings.experimental.petdex.messages.test')}
        </Button>
      </div>
      <Collapsible className="flex min-w-0 flex-col gap-2">
      <CollapsibleTrigger render={<Button size="sm" variant="ghost" className="self-start" />}><ChevronDownIcon data-icon="inline-start" />{t('settings.experimental.petdex.messages.diagnostic')}</CollapsibleTrigger>
      <CollapsibleContent>
      <dl className="flex min-w-0 flex-col gap-2 text-xs [&>div]:flex [&>div]:flex-wrap [&>div]:justify-between [&>div]:gap-x-4 [&_dt]:text-muted-foreground" aria-label={t('settings.experimental.petdex.messages.diagnostic')}>
        {configurationFailed && <div><dt>{t('settings.experimental.petdex.messages.configuration')}</dt><dd>{t('settings.experimental.petdex.messages.configurationFailed')}</dd></div>}
        <div><dt>{t('settings.experimental.petdex.messages.diagnostic')}</dt><dd>{t(`settings.experimental.petdex.messages.status.${unavailable ? 'unavailable' : diagnostic?.status ?? 'disabled'}`)}</dd></div>
        <div><dt>{t('settings.experimental.petdex.messages.lastAccepted')}</dt><dd>{diagnostic?.lastAcceptedAt == null ? t('settings.experimental.petdex.never') : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(diagnostic.lastAcceptedAt)}</dd></div>
        <div><dt>{t('settings.experimental.petdex.messages.slots')}</dt><dd>{diagnostic?.usedSlotCount ?? 0} / 3</dd></div>
        <div><dt>{t('settings.experimental.petdex.messages.cleanup')}</dt><dd>{t(`settings.experimental.petdex.messages.cleanup.${diagnostic?.cleanupOutcome ?? 'notNeeded'}`)}</dd></div>
      </dl>
      </CollapsibleContent>
      </Collapsible>
    </div>
  </>;
}
