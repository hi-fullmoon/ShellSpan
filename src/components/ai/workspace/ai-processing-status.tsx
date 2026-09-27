import { MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { AI_DISCLOSURE_LEADING_CLASS, AI_DISCLOSURE_TITLE_CLASS } from './ai-style-classes';

/** Shared content for the pending indicator and the running process trigger. */
export function AiProcessingStatus() {
  const { t } = useI18n();
  return <>
    <MarkerIcon className={AI_DISCLOSURE_LEADING_CLASS}><Spinner aria-hidden="true" /></MarkerIcon>
    <MarkerContent className={`shimmer ${AI_DISCLOSURE_TITLE_CLASS}`}>{t('ai.workspace.turnProcess.running')}</MarkerContent>
  </>;
}
