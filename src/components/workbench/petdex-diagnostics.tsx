import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import type { PetdexConnectionStatus, PetdexDiagnostic, PetdexHealth } from '@/types';

export function PetdexDiagnostics({ snapshot, status, health }: {
  snapshot: PetdexDiagnostic | null;
  status: PetdexConnectionStatus;
  health: PetdexHealth | null;
}) {
  const { t, locale } = useI18n();
  return (
    <Collapsible className="flex min-w-0 flex-col gap-2">
      <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
        <ChevronDownIcon data-icon="inline-start" />
        {t('settings.experimental.petdex.details')}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col gap-2">
        <p>{t(`settings.experimental.petdex.advice.${status}`)}</p>
        <dl className="flex flex-col gap-2">
          <div><dt>{t('settings.experimental.petdex.health')}</dt><dd>{t(`settings.experimental.petdex.health.${health ?? 'none'}`)}</dd></div>
          <div><dt>{t('settings.experimental.petdex.target')}</dt><dd>{t(`settings.experimental.petdex.action.${snapshot?.targetAction ?? 'none'}`)}</dd></div>
          <div><dt>{t('settings.experimental.petdex.lastSuccess')}</dt><dd>{snapshot?.lastSuccessAt == null
            ? t('settings.experimental.petdex.never')
            : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(snapshot.lastSuccessAt)}</dd></div>
        </dl>
        <p>{t('settings.experimental.petdex.historyNote')}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}
