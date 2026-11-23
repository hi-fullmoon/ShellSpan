import React, { useCallback, useEffect, useState } from 'react';
import { HistoryIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { aiErrorMessage } from '@/lib/ai/error-message';
import {
  invokeListFileCheckpoints,
  invokePreviewFileCheckpoint,
  invokeRestoreFileCheckpoint,
  type AgentFileCheckpoint,
  type FileCheckpointDiffPreview,
} from '@/lib/ipc/tauri';

interface FileCheckpointRollbackDialogProps {
  readonly sessionId: string;
  readonly refreshSignal?: string | number;
}

export function FileCheckpointRollbackDialog({
  sessionId,
  refreshSignal,
}: FileCheckpointRollbackDialogProps): React.ReactElement | null {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<readonly AgentFileCheckpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileCheckpointDiffPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<AgentFileCheckpoint | null>(null);

  const loadPreview = useCallback(async (checkpointId: string) => {
    setActiveId(checkpointId);
    setPreviewLoading(true);
    try {
      const next = await invokePreviewFileCheckpoint(sessionId, checkpointId);
      setPreview(next);
    } catch (error) {
      setPreview(null);
      const raw = error instanceof Error ? error.message : String(error);
      const translated = aiErrorMessage(raw, t);
      showError(translated !== raw ? translated : t('ai.checkpointRollback.previewFailed'));
    } finally {
      setPreviewLoading(false);
    }
  }, [sessionId, showError, t]);

  const loadList = useCallback(async (showFailureToast: boolean) => {
    setLoading(true);
    try {
      const raw = await invokeListFileCheckpoints(sessionId);
      const items = Array.isArray(raw) ? raw : [];
      setCheckpoints(items);
      if (items.length === 0) {
        setActiveId(null);
        setPreview(null);
      } else {
        setActiveId((current) => (
          current && items.some((item) => item.checkpointId === current) ? current : items[0].checkpointId
        ));
      }
    } catch {
      if (showFailureToast) showError(t('ai.checkpointRollback.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [sessionId, showError, t]);

  useEffect(() => {
    void loadList(false);
  }, [loadList, refreshSignal]);

  useEffect(() => {
    if (!open || !activeId) return;
    void loadPreview(activeId);
  }, [open, activeId, loadPreview]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      void loadList(true);
    }
  };

  const activeCheckpoint = checkpoints.find((item) => item.checkpointId === activeId) ?? null;

  const handleConfirmRestore = async () => {
    if (!confirmTarget || restoring) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    setRestoring(true);
    try {
      const result = await invokeRestoreFileCheckpoint(sessionId, target.checkpointId);
      if (result.action === 'restored') {
        showSuccess(t('ai.checkpointRollback.restoreSuccess', { path: target.targetPath }));
      } else if (result.action === 'trashed') {
        showSuccess(t('ai.checkpointRollback.trashSuccess', { path: target.targetPath }));
      } else if (result.action === 'removed') {
        showSuccess(t('ai.checkpointRollback.removeSuccess', { path: target.targetPath }));
      } else {
        showSuccess(t('ai.checkpointRollback.unchangedNotice', { path: target.targetPath }));
      }
      await loadList(false);
      await loadPreview(target.checkpointId);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const translated = aiErrorMessage(raw, t);
      showError(translated !== raw ? translated : t('ai.checkpointRollback.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  if (checkpoints.length === 0) return null;

  const confirmDescription = confirmTarget
    ? confirmTarget.originalSha256
      ? t('ai.checkpointRollback.confirmRestore', { path: confirmTarget.targetPath })
      : confirmTarget.targetKind === 'remote'
        ? t('ai.checkpointRollback.confirmRemoveRemote', { path: confirmTarget.targetPath })
        : t('ai.checkpointRollback.confirmTrashLocal', { path: confirmTarget.targetPath })
    : '';

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        data-testid="file-checkpoint-rollback-trigger"
        onClick={() => handleOpenChange(true)}
      >
        <HistoryIcon aria-hidden="true" className="size-3.5" />
        <span>{t('ai.checkpointRollback.button')}</span>
        <Badge variant="secondary" size="sm">
          {checkpoints.length}
        </Badge>
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex h-[min(78vh,620px)] max-w-3xl flex-col gap-3 overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('ai.checkpointRollback.title')}</DialogTitle>
            <DialogDescription>{t('ai.checkpointRollback.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[240px_1fr]">
            <ScrollArea className="min-h-0 rounded-md border">
              <div className="flex flex-col gap-1 p-1.5">
                {loading && checkpoints.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">{t('ai.checkpointRollback.loading')}</p>
                ) : checkpoints.map((item) => {
                  const selected = item.checkpointId === activeId;
                  return (
                    <button
                      key={item.checkpointId}
                      type="button"
                      onClick={() => setActiveId(item.checkpointId)}
                      className={`flex flex-col gap-1 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                      }`}
                    >
                      <span className="truncate font-mono" title={item.targetPath}>
                        {item.targetPath}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" size="sm">
                          {t(item.originalSha256 ? 'ai.checkpointRollback.badgeModified' : 'ai.checkpointRollback.badgeCreated')}
                        </Badge>
                        {item.restoredAtUnixMs && (
                          <Badge variant="secondary" size="sm">
                            {t('ai.checkpointRollback.badgeRestored')}
                          </Badge>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
            <div className="flex min-h-0 flex-col rounded-md border">
              {previewLoading ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.previewLoading')}</p>
              ) : !preview ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.selectPrompt')}</p>
              ) : preview.unchanged ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.unchanged')}</p>
              ) : preview.isBinary ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.binaryPreview')}</p>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col gap-2 p-3">
                    {preview.truncated && (
                      <p className="text-xs text-muted-foreground">{t('ai.checkpointRollback.truncatedDiff')}</p>
                    )}
                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
                      {preview.unifiedDiff}
                    </pre>
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={loading || restoring}
              onClick={() => void loadList(true)}
            >
              <RefreshCwIcon aria-hidden="true" className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{t('ai.checkpointRollback.refresh')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1"
              disabled={!activeCheckpoint || restoring || Boolean(preview?.unchanged)}
              onClick={() => {
                if (activeCheckpoint) setConfirmTarget(activeCheckpoint);
              }}
            >
              <RotateCcwIcon aria-hidden="true" className="size-3.5" />
              <span>{t(restoring ? 'ai.checkpointRollback.restoring' : 'ai.checkpointRollback.restore')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmTarget(null);
        }}
        title={t('ai.checkpointRollback.confirmTitle')}
        description={confirmDescription}
        confirmLabel={t('ai.checkpointRollback.restore')}
        confirmVariant={confirmTarget && !confirmTarget.originalSha256 && confirmTarget.targetKind === 'remote' ? 'destructive' : 'warning'}
        onConfirm={() => void handleConfirmRestore()}
      />
    </>
  );
}
