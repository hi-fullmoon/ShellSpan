import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangleIcon, HistoryIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  invokeRestoreFileCheckpointsBatch,
  type AgentFileCheckpoint,
  type FileCheckpointDiffPreview,
} from '@/lib/ipc/tauri';

export interface FileCheckpointOpenRequest {
  readonly nonce: number;
  readonly focusPaths?: readonly string[];
}

interface FileCheckpointRollbackDialogProps {
  readonly sessionId: string;
  readonly refreshSignal?: string | number;
  readonly refreshEnabled?: boolean;
  readonly openRequest?: FileCheckpointOpenRequest | null;
  readonly onCheckpointsCountChange?: (count: number) => void;
}

function normalizeCheckpointPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function findMatchingCheckpointId(
  items: readonly AgentFileCheckpoint[],
  focusPaths?: readonly string[],
): string | null {
  if (!focusPaths?.length) return null;
  const normalizedFocus = focusPaths.map(normalizeCheckpointPath).filter(Boolean);
  for (const focus of normalizedFocus) {
    const exact = items.find((item) => normalizeCheckpointPath(item.targetPath) === focus);
    if (exact) return exact.checkpointId;
  }
  for (const focus of normalizedFocus) {
    const suffix = items.find((item) => {
      const candidate = normalizeCheckpointPath(item.targetPath);
      return candidate.endsWith(`/${focus}`) || focus.endsWith(`/${candidate}`);
    });
    if (suffix) return suffix.checkpointId;
  }
  return null;
}

interface SingleConfirmState {
  readonly checkpoint: AgentFileCheckpoint;
  readonly conflict: boolean;
}

interface BatchConfirmState {
  readonly checkpointIds: readonly string[];
  readonly conflictOverwrite: boolean;
}

export function FileCheckpointRollbackDialog({
  sessionId,
  refreshSignal,
  refreshEnabled = true,
  openRequest = null,
  onCheckpointsCountChange,
}: FileCheckpointRollbackDialogProps): React.ReactElement | null {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const onCheckpointsCountChangeRef = useRef(onCheckpointsCountChange);
  onCheckpointsCountChangeRef.current = onCheckpointsCountChange;
  const { error: showError, success: showSuccess } = useToast();
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<readonly AgentFileCheckpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<FileCheckpointDiffPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [singleConfirm, setSingleConfirm] = useState<SingleConfirmState | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirmState | null>(null);
  const listRequestSeqRef = useRef(0);
  const previewRequestSeqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const loadPreview = useCallback(async (checkpointId: string) => {
    const seq = ++previewRequestSeqRef.current;
    setActiveId(checkpointId);
    setPreviewLoading(true);
    try {
      const next = await invokePreviewFileCheckpoint(sessionId, checkpointId);
      if (seq !== previewRequestSeqRef.current) return;
      setPreview(next);
    } catch (error) {
      if (seq !== previewRequestSeqRef.current) return;
      setPreview(null);
      const raw = error instanceof Error ? error.message : String(error);
      const translated = aiErrorMessage(raw, tRef.current);
      showError(translated !== raw ? translated : tRef.current('ai.checkpointRollback.previewFailed'));
    } finally {
      if (seq === previewRequestSeqRef.current) {
        setPreviewLoading(false);
      }
    }
  }, [sessionId, showError]);

  const loadList = useCallback(async (
    showFailureToast: boolean,
    focusPaths?: readonly string[],
  ): Promise<string | null> => {
    const seq = ++listRequestSeqRef.current;
    setLoading(true);
    try {
      const raw = await invokeListFileCheckpoints(sessionId);
      if (seq !== listRequestSeqRef.current) return activeIdRef.current;
      const items = Array.isArray(raw) ? raw : [];
      setCheckpoints(items);
      onCheckpointsCountChangeRef.current?.(items.length);
      const validIds = new Set(items.map((item) => item.checkpointId));
      setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
      if (items.length === 0) {
        setActiveId(null);
        setPreview(null);
        return null;
      }
      const matchedId = findMatchingCheckpointId(items, focusPaths);
      const current = activeIdRef.current;
      const nextActiveId = matchedId
        ?? (current && items.some((item) => item.checkpointId === current)
          ? current
          : items[0].checkpointId);
      setActiveId(nextActiveId);
      return nextActiveId;
    } catch {
      if (seq === listRequestSeqRef.current && showFailureToast) {
        showError(tRef.current('ai.checkpointRollback.loadFailed'));
      }
      return activeIdRef.current;
    } finally {
      if (seq === listRequestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [sessionId, showError]);

  useEffect(() => {
    if (!refreshEnabled) return;
    void loadList(false);
  }, [loadList, refreshSignal, refreshEnabled]);

  const lastHandledOpenNonceRef = useRef<number>(0);
  useEffect(() => {
    if (!openRequest || openRequest.nonce === 0 || openRequest.nonce === lastHandledOpenNonceRef.current) {
      return;
    }
    lastHandledOpenNonceRef.current = openRequest.nonce;
    setOpen(true);
    const matchedLocal = findMatchingCheckpointId(checkpoints, openRequest.focusPaths);
    if (matchedLocal) setActiveId(matchedLocal);
    void loadList(true, openRequest.focusPaths);
  }, [checkpoints, loadList, openRequest]);

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
  const unrestoredIds = checkpoints.filter((item) => !item.restoredAtUnixMs).map((item) => item.checkpointId);
  const allUnrestoredSelected = unrestoredIds.length > 0 && unrestoredIds.every((id) => selectedIds.includes(id));

  const toggleSelection = (checkpointId: string, checked: boolean) => {
    setSelectedIds((prev) => (
      checked
        ? prev.includes(checkpointId) ? prev : [...prev, checkpointId]
        : prev.filter((id) => id !== checkpointId)
    ));
  };

  const handleToggleSelectAll = () => {
    if (allUnrestoredSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(unrestoredIds);
    }
  };

  const handleConfirmSingleRestore = async () => {
    if (!singleConfirm || restoring) return;
    const { checkpoint: target, conflict } = singleConfirm;
    setSingleConfirm(null);
    setRestoring(true);
    try {
      const result = await invokeRestoreFileCheckpoint(sessionId, target.checkpointId, conflict);
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
      if (raw.startsWith('CHECKPOINT_MANUAL_EDIT_CONFLICT') && !conflict) {
        setSingleConfirm({ checkpoint: target, conflict: true });
        return;
      }
      const translated = aiErrorMessage(raw, t);
      showError(translated !== raw ? translated : t('ai.checkpointRollback.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  const handleConfirmBatchRestore = async () => {
    if (!batchConfirm || restoring) return;
    const { checkpointIds, conflictOverwrite } = batchConfirm;
    setBatchConfirm(null);
    setRestoring(true);
    try {
      const result = await invokeRestoreFileCheckpointsBatch(sessionId, checkpointIds, conflictOverwrite);
      if (result.restored.length > 0 && result.failed.length === 0 && result.conflicts.length === 0) {
        showSuccess(t('ai.checkpointRollback.batchSuccess', { count: result.restored.length }));
        setSelectedIds([]);
      } else if (result.restored.length > 0 && result.failed.length > 0) {
        showError(t('ai.checkpointRollback.batchPartial', {
          restored: result.restored.length,
          failed: result.failed.length,
        }));
      } else if (result.failed.length > 0) {
        showError(t('ai.checkpointRollback.restoreFailed'));
      } else if (result.restored.length > 0 && result.conflicts.length > 0) {
        showSuccess(t('ai.checkpointRollback.batchSuccess', { count: result.restored.length }));
      }
      const nextActiveId = await loadList(false);
      if (nextActiveId) {
        await loadPreview(nextActiveId);
      }
      if (result.conflicts.length > 0 && !conflictOverwrite) {
        setSelectedIds(result.conflicts);
        setBatchConfirm({ checkpointIds: result.conflicts, conflictOverwrite: true });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const translated = aiErrorMessage(raw, t);
      showError(translated !== raw ? translated : t('ai.checkpointRollback.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  if (checkpoints.length === 0) return null;

  const singleConfirmDescription = singleConfirm
    ? singleConfirm.conflict
      ? singleConfirm.checkpoint.originalSha256
        ? t('ai.checkpointRollback.confirmConflictRestore', { path: singleConfirm.checkpoint.targetPath })
        : singleConfirm.checkpoint.targetKind === 'remote'
          ? t('ai.checkpointRollback.confirmConflictRemoveRemote', { path: singleConfirm.checkpoint.targetPath })
          : t('ai.checkpointRollback.confirmConflictTrashLocal', { path: singleConfirm.checkpoint.targetPath })
      : singleConfirm.checkpoint.originalSha256
        ? t('ai.checkpointRollback.confirmRestore', { path: singleConfirm.checkpoint.targetPath })
        : singleConfirm.checkpoint.targetKind === 'remote'
          ? t('ai.checkpointRollback.confirmRemoveRemote', { path: singleConfirm.checkpoint.targetPath })
          : t('ai.checkpointRollback.confirmTrashLocal', { path: singleConfirm.checkpoint.targetPath })
    : '';

  const batchConflictPaths = batchConfirm?.conflictOverwrite
    ? batchConfirm.checkpointIds
        .map((id) => checkpoints.find((item) => item.checkpointId === id)?.targetPath ?? id)
        .join(', ')
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
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[260px_1fr]">
            <div className="flex min-h-0 flex-col rounded-md border">
              {unrestoredIds.length > 0 && (
                <div className="flex shrink-0 items-center justify-between border-b px-2 py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={loading || restoring}
                    onClick={handleToggleSelectAll}
                  >
                    {t(allUnrestoredSelected ? 'ai.checkpointRollback.clearSelection' : 'ai.checkpointRollback.selectAll')}
                  </Button>
                  {selectedIds.length > 0 && (
                    <Badge variant="secondary" size="sm">{selectedIds.length}</Badge>
                  )}
                </div>
              )}
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-1 p-1.5">
                  {loading && checkpoints.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">{t('ai.checkpointRollback.loading')}</p>
                  ) : checkpoints.map((item) => {
                    const selected = item.checkpointId === activeId;
                    const checked = selectedIds.includes(item.checkpointId);
                    return (
                      <div
                        key={item.checkpointId}
                        className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        }`}
                      >
                        <Checkbox
                          aria-label={item.targetPath}
                          checked={checked}
                          disabled={restoring}
                          className="mt-0.5"
                          onCheckedChange={(next) => toggleSelection(item.checkpointId, Boolean(next))}
                        />
                        <button
                          type="button"
                          onClick={() => setActiveId(item.checkpointId)}
                          className="flex min-w-0 flex-1 flex-col gap-1 text-left"
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
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
            <div className="flex min-h-0 flex-col rounded-md border">
              {previewLoading ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.previewLoading')}</p>
              ) : !preview ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.selectPrompt')}</p>
              ) : preview.unchanged ? (
                <p className="p-3 text-xs text-muted-foreground">{t('ai.checkpointRollback.unchanged')}</p>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col gap-2 p-3">
                    {preview.modifiedAfterAgent && (
                      <Alert variant="destructive" data-testid="file-checkpoint-conflict-alert">
                        <AlertTriangleIcon aria-hidden="true" className="size-4" />
                        <AlertDescription>
                          {t('ai.checkpointRollback.conflictBanner')}
                        </AlertDescription>
                      </Alert>
                    )}
                    {preview.isBinary ? (
                      <p className="text-xs text-muted-foreground">{t('ai.checkpointRollback.binaryPreview')}</p>
                    ) : (
                      <>
                        {preview.truncated && (
                          <p className="text-xs text-muted-foreground">{t('ai.checkpointRollback.truncatedDiff')}</p>
                        )}
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
                          {preview.unifiedDiff}
                        </pre>
                      </>
                    )}
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
            {selectedIds.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={restoring}
                data-testid="file-checkpoint-batch-restore"
                onClick={() => setBatchConfirm({ checkpointIds: selectedIds, conflictOverwrite: false })}
              >
                <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                <span>{t('ai.checkpointRollback.batchRestore', { count: selectedIds.length })}</span>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="gap-1"
              disabled={!activeCheckpoint || restoring || Boolean(preview?.unchanged)}
              onClick={() => {
                if (activeCheckpoint) {
                  setSingleConfirm({
                    checkpoint: activeCheckpoint,
                    conflict: Boolean(preview?.modifiedAfterAgent),
                  });
                }
              }}
            >
              <RotateCcwIcon aria-hidden="true" className="size-3.5" />
              <span>{t(restoring ? 'ai.checkpointRollback.restoring' : 'ai.checkpointRollback.restore')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        open={Boolean(singleConfirm)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSingleConfirm(null);
        }}
        title={t('ai.checkpointRollback.confirmTitle')}
        description={singleConfirmDescription}
        confirmLabel={t(singleConfirm?.conflict ? 'ai.checkpointRollback.confirmConflictOverwrite' : 'ai.checkpointRollback.restore')}
        confirmVariant={
          singleConfirm && (singleConfirm.conflict || (!singleConfirm.checkpoint.originalSha256 && singleConfirm.checkpoint.targetKind === 'remote'))
            ? 'destructive'
            : 'warning'
        }
        onConfirm={() => void handleConfirmSingleRestore()}
      />
      <ConfirmationDialog
        open={Boolean(batchConfirm)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setBatchConfirm(null);
        }}
        title={t(
          batchConfirm?.conflictOverwrite
            ? 'ai.checkpointRollback.batchConflictConfirmTitle'
            : 'ai.checkpointRollback.batchConfirmTitle',
          { count: batchConfirm?.checkpointIds.length ?? 0 },
        )}
        description={
          batchConfirm?.conflictOverwrite
            ? t('ai.checkpointRollback.batchConflictConfirmDescription', { paths: batchConflictPaths })
            : t('ai.checkpointRollback.batchConfirmDescription')
        }
        confirmLabel={t(
          batchConfirm?.conflictOverwrite
            ? 'ai.checkpointRollback.confirmConflictOverwrite'
            : 'ai.checkpointRollback.restore',
        )}
        confirmVariant={batchConfirm?.conflictOverwrite ? 'destructive' : 'warning'}
        onConfirm={() => void handleConfirmBatchRestore()}
      />
    </>
  );
}
