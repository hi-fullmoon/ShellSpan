import { useRef, useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useToast } from '@/hooks/useToast';
import type { useI18n } from '@/hooks/useI18n';
import { deleteAgentSessionRecord, orderSessionRecordsForDeletion } from '@/lib/ai/session-records';
import type { AgentSessionListItem } from '@/types/agent-session';

export function AiSessionRecordsDeleteAll({ records, disabled, t, onBusyChange, onDeleted, onSettled }: {
  readonly records: readonly AgentSessionListItem[];
  readonly disabled: boolean;
  readonly t: ReturnType<typeof useI18n>['t'];
  readonly onBusyChange: (busy: boolean) => void;
  readonly onDeleted: (sessionId: string) => void;
  readonly onSettled: () => Promise<void>;
}) {
  const [targets, setTargets] = useState<readonly AgentSessionListItem[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const running = useRef(false);
  const { success, error } = useToast();

  const deleteAll = async () => {
    if (!targets?.length || disabled || running.current) return;
    running.current = true;
    onBusyChange(true);
    setProgress(0);
    let deleted = 0;
    try {
      for (const record of orderSessionRecordsForDeletion(targets)) {
        await deleteAgentSessionRecord(record);
        deleted++;
        onDeleted(record.header.sessionId);
        setProgress(deleted);
      }
      success(t('settings.ai.records.deletedAll', { count: deleted }));
    } catch {
      // Stop at the first failure so dependent source histories remain intact.
      error(t('settings.ai.records.deleteAllFailed', { count: deleted, remaining: targets.length - deleted }));
    } finally {
      try {
        await onSettled();
      } finally {
        running.current = false;
        onBusyChange(false);
        setProgress(null);
        setTargets(null);
      }
    }
  };

  return (
    <>
      <Button variant="destructiveOutline" size="sm" disabled={disabled || records.length === 0 || progress !== null} onClick={() => setTargets([...records])}>
        {t('settings.ai.records.deleteAll')}
      </Button>
      <ConfirmationDialog
        open={targets !== null}
        onOpenChange={(open) => { if (!open && !running.current) setTargets(null); }}
        title={t('settings.ai.records.deleteAllTitle')}
        description={t('settings.ai.records.deleteAllDescription', { count: targets?.length ?? 0 })}
        confirmLabel={progress === null ? t('settings.ai.records.deleteAll')
          : t('settings.ai.records.deletingAll', { count: progress, total: targets?.length ?? 0 })}
        confirmVariant="destructive"
        confirmPending={progress !== null}
        confirmDisabled={disabled}
        media={<Trash2Icon />}
        mediaVariant="destructive"
        onConfirm={() => void deleteAll()}
      />
    </>
  );
}
