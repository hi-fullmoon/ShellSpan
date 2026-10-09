import { useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { invokeAbortAgentRuntimeRecovery, invokeReconcileDirectResources } from '@/lib/ipc/tauri';
import type { DirectResourceRecovery } from '@/types/agent-execution';

/** Cleanup receipts release resources only. A new conversation gets new approvals. */
export function AiNativeRecoveryNotice({ sessionId, onRefresh, onNewSession }: {
  readonly sessionId: string;
  readonly onRefresh?: () => Promise<void>;
  readonly onNewSession?: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<DirectResourceRecovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const run = async (finish: boolean): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      // Recheck at the final action: a prior receipt is never execution authority.
      const actual = await invokeReconcileDirectResources();
      setReceipt(actual);
      if (finish && actual.uncertain === 0) {
        await invokeAbortAgentRuntimeRecovery({ sessionId });
        await onRefresh?.();
        onNewSession?.();
      }
    } catch (cause) {
      setReceipt(null);
      setError(aiErrorMessage(cause instanceof Error ? cause.message : String(cause), t));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Alert variant="warning" size="sm" data-slot="ai-native-recovery-notice">
    <AlertTitle>{t('agent.recovery.gateTitle')}</AlertTitle>
    <AlertDescription className="flex flex-col gap-2">
      <span>{t('agent.recovery.gateNotice')}</span>
      {receipt && <span role="status">{t(receipt.uncertain === 0 ? 'agent.recovery.resourcesConfirmed' : 'agent.recovery.resourcesUnknown', {
        resolved: receipt.resolved, uncertain: receipt.uncertain,
      })}</span>}
      {error && <span role="status">{error}</span>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(false); }}>
          {busy && <Spinner data-icon="inline-start" />}{t('agent.recovery.checkResources')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !receipt || receipt.uncertain !== 0 || !onNewSession}
          onClick={() => { void run(true); }}>{t('agent.recovery.finishInterrupted')}</Button>
      </div>
    </AlertDescription>
  </Alert>;
}
