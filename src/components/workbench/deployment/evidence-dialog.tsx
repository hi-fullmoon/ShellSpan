import React from 'react';
import { ScrollTextIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { invokeExportDeploymentRunAudit } from '@/lib/ipc/tauri';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useToastStore } from '@/stores/toastStore';
import { deploymentEventLabel, deploymentRuntimeKey } from './runtime-utils';

export interface EvidenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: DeploymentWorkflowRecord;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export const EvidenceDialog: React.FC<EvidenceDialogProps> = ({
  open,
  onOpenChange,
  workflow,
  returnFocusRef,
}) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const node = state.nodes.find((item) => item.nodeId === state.selectedNodeId) ?? null;
  const nodeLabel = node
    ? workflow.definition.nodes.find((item) => item.id === node.nodeId)?.displayName ?? node.nodeId
    : null;
  const outputs = state.detail?.outputs.filter((output) => output.nodeId === node?.nodeId) ?? [];
  const receipts = state.detail?.receipts.filter((receipt) => receipt.nodeId === node?.nodeId) ?? [];
  const events = state.events.filter((event) => event.nodeId === node?.nodeId);
  const [exporting, setExporting] = React.useState(false);

  const exportAudit = async (): Promise<void> => {
    const runId = state.selectedRunId;
    if (!runId || exporting) return;
    setExporting(true);
    try {
      const result = await invokeExportDeploymentRunAudit(runId);
      if (result.saved) {
        useToastStore.getState().addToast(t('deployment.history.auditExported'), 'success');
      }
    } catch {
      useToastStore.getState().addToast(t('deployment.history.auditExportFailed'), 'error');
    } finally {
      setExporting(false);
    }
  };

  const empty = outputs.length === 0 && receipts.length === 0 && events.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) returnFocusRef?.current?.focus(); }}
    >
      <DialogContent
        className="flex h-[min(44rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        data-testid="deployment-evidence-dialog"
      >
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>{t('deployment.runtime.evidence.title')}</DialogTitle>
          <DialogDescription>
            {nodeLabel
              ? t('deployment.runtime.evidence.description', { node: nodeLabel })
              : t('deployment.runtime.evidence.empty')}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 px-4 pb-4">
            {outputs.length > 0 && (
              <section className="flex flex-col gap-3 pt-4">
                <h3 className="text-sm font-medium">{t('deployment.runtime.evidence.outputs')}</h3>
                {outputs.map((output) => (
                  <div key={output.outputName} className="flex flex-col gap-2 border-b pb-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-medium">{output.outputName}</h4>
                      <Badge variant="outline">
                        {t(deploymentRuntimeKey(`deployment.runtime.output.${output.outputKind}`))}
                      </Badge>
                    </div>
                    <pre className="max-w-full whitespace-pre-wrap break-words text-xs">
                      {JSON.stringify(output.value, null, 2)}
                    </pre>
                  </div>
                ))}
              </section>
            )}
            {outputs.length > 0 && receipts.length > 0 && <Separator />}
            {receipts.length > 0 && (
              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-medium">{t('deployment.runtime.evidence.receipts')}</h3>
                {receipts.map((receipt) => (
                  <div key={receipt.operationId} className="flex flex-col gap-1 border-b pb-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-medium">{receipt.receiptType}</h4>
                      <Badge variant="outline">
                        {t('deployment.runtime.attemptNumber', { attempt: receipt.attempt })}
                      </Badge>
                    </div>
                    <code className="break-all text-xs text-muted-foreground">{receipt.payloadDigest}</code>
                  </div>
                ))}
              </section>
            )}
            {(outputs.length > 0 || receipts.length > 0) && events.length > 0 && <Separator />}
            {events.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('deployment.runtime.logs')}</h3>
                <div className="flex flex-col gap-2 font-mono text-xs">
                  {events.map((event) => (
                    <div key={event.sequence}>#{event.sequence} · {deploymentEventLabel(event.summaryKey, t)}</div>
                  ))}
                </div>
              </section>
            )}
            {empty && (
              <EmptyState
                icon={<ScrollTextIcon />}
                title={t('deployment.runtime.evidence.empty')}
                description={t('deployment.runtime.evidence.emptyDescription')}
              />
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t p-4">
          <Button
            variant="outline"
            onClick={() => void exportAudit()}
            disabled={!state.selectedRunId || exporting}
          >
            {exporting
              ? <Spinner data-icon="inline-start" />
              : <ScrollTextIcon data-icon="inline-start" />}
            {t('deployment.history.exportAudit')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
