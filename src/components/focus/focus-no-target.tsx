import { PlusIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { useFocusStore } from '@/stores/focusStore';

export function FocusNoTarget(): React.ReactNode {
  const { t } = useI18n();
  return <Alert size="sm"><AlertDescription className="flex flex-wrap items-center justify-between gap-1">
    {t('focus.connectFirst')}
    <Button size="xs" variant="outline" onClick={() => {
      useFocusStore.getState().setTerminalOpen(true);
      document.dispatchEvent(new Event('shellspan:new-terminal-tab'));
    }}><PlusIcon data-icon="inline-start" />{t('focus.connect')}</Button>
  </AlertDescription></Alert>;
}
