import { MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

/** Shared content for the pending indicator and the running process trigger. */
export function AiProcessingStatus({ iconClassName, labelClassName }: {
  readonly iconClassName?: string;
  readonly labelClassName?: string;
}) {
  const { t } = useI18n();
  return <>
    <MarkerIcon className={iconClassName}><Spinner aria-hidden="true" /></MarkerIcon>
    <MarkerContent className={cn('shimmer', labelClassName)}>{t('ai.workspace.turnProcess.running')}</MarkerContent>
  </>;
}
