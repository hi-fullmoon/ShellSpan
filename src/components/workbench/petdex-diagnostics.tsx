import { useEffect, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { getPetdexMessageDiagnostic } from '@/lib/petdex/messages';
import { PETDEX_STATUS_LABEL_KEYS } from '@/lib/petdex/diagnostic';
import type { PetdexConnectionStatus, PetdexDiagnostic, PetdexHealth } from '@/types';

export function PetdexDiagnostics({ snapshot, status, health }: {
  snapshot: PetdexDiagnostic | null;
  status: PetdexConnectionStatus;
  health: PetdexHealth | null;
}) {
  const { t, locale } = useI18n();
  const configurationFailed = useAppStore((s) => s.petdexConfigurationFailed);
  const messageDiagnostic = useAppStore((s) => s.petdexMessageDiagnostic);
  const [messageUnavailable, setMessageUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await getPetdexMessageDiagnostic();
        if (!cancelled) {
          useAppStore.getState().receivePetdexMessageDiagnostic(next);
          setMessageUnavailable(false);
        }
      } catch {
        if (!cancelled) setMessageUnavailable(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const messageStatusKey = `settings.experimental.petdex.messages.status.${messageUnavailable ? 'unavailable' : messageDiagnostic?.status ?? 'disabled'}` as const;

  return (
    <section data-slot="petdex-diagnostics" className="flex min-w-0 flex-col">
      <Card size="sm" radius="compact" variant="outline" className="gap-0 py-0">
      <Collapsible className="flex min-w-0 flex-col">
        <CollapsibleTrigger
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&[aria-expanded=true]_.petdex-chevron]:rotate-180"
        >
          <span className="flex min-w-0 items-center text-sm font-medium text-foreground">
            <span className="truncate">{t('settings.experimental.petdex.details')}</span>
          </span>
          <span aria-hidden="true" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden @min-[26rem]:inline">
              {t(PETDEX_STATUS_LABEL_KEYS[status])} · {t(messageStatusKey)}
            </span>
            <ChevronDownIcon className="petdex-chevron size-4 shrink-0 transition-transform duration-200" />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="flex min-w-0 flex-col">
          <Separator className="mx-4 data-horizontal:w-auto" />
          <div className="grid grid-cols-1 gap-4 px-4 py-3.5 @min-[36rem]:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <h4 className="text-xs font-medium text-foreground">
                {t('settings.experimental.petdex.status')}
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(`settings.experimental.petdex.advice.${status}`)}
              </p>
              <dl className="flex min-w-0 flex-col gap-1.5 text-xs [&>div]:flex [&>div]:flex-wrap [&>div]:justify-between [&>div]:gap-x-3 [&_dt]:text-muted-foreground [&_dd]:text-foreground">
                <div>
                  <dt>{t('settings.experimental.petdex.health')}</dt>
                  <dd>{t(`settings.experimental.petdex.health.${health ?? 'none'}`)}</dd>
                </div>
                <div>
                  <dt>{t('settings.experimental.petdex.target')}</dt>
                  <dd>{t(`settings.experimental.petdex.action.${snapshot?.targetAction ?? 'none'}`)}</dd>
                </div>
                <div>
                  <dt>{t('settings.experimental.petdex.lastSuccess')}</dt>
                  <dd>
                    {snapshot?.lastSuccessAt == null
                      ? t('settings.experimental.petdex.never')
                      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(snapshot.lastSuccessAt)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex min-w-0 flex-col gap-2 @min-[36rem]:border-l-[0.5px] @min-[36rem]:border-border/50 @min-[36rem]:pl-4">
              <h4 className="text-xs font-medium text-foreground">
                {t('settings.experimental.petdex.messages.diagnostic')}
              </h4>
              <dl
                aria-label={t('settings.experimental.petdex.messages.diagnostic')}
                className="flex min-w-0 flex-col gap-1.5 text-xs [&>div]:flex [&>div]:flex-wrap [&>div]:justify-between [&>div]:gap-x-3 [&_dt]:text-muted-foreground [&_dd]:text-foreground"
              >
                {configurationFailed && (
                  <div>
                    <dt>{t('settings.experimental.petdex.messages.configuration')}</dt>
                    <dd>{t('settings.experimental.petdex.messages.configurationFailed')}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('settings.experimental.petdex.messages.diagnostic')}</dt>
                  <dd>{t(messageStatusKey)}</dd>
                </div>
                <div>
                  <dt>{t('settings.experimental.petdex.messages.lastAccepted')}</dt>
                  <dd>
                    {messageDiagnostic?.lastAcceptedAt == null
                      ? t('settings.experimental.petdex.never')
                      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(messageDiagnostic.lastAcceptedAt)}
                  </dd>
                </div>
                <div>
                  <dt>{t('settings.experimental.petdex.messages.slots')}</dt>
                  <dd>{messageDiagnostic?.usedSlotCount ?? 0} / 3</dd>
                </div>
                <div>
                  <dt>{t('settings.experimental.petdex.messages.cleanup')}</dt>
                  <dd>{t(`settings.experimental.petdex.messages.cleanup.${messageDiagnostic?.cleanupOutcome ?? 'notNeeded'}`)}</dd>
                </div>
              </dl>
            </div>
          </div>

          <p className="border-t-[0.5px] border-border/50 bg-muted/25 px-4 py-2 text-xs leading-relaxed text-muted-foreground">
            {t('settings.experimental.petdex.communicationNote')} {t('settings.experimental.petdex.historyNote')}
          </p>
        </CollapsibleContent>
      </Collapsible>
      </Card>
    </section>
  );
}
