import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangleIcon, FileDiffIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog } from '@/components/ui/dialog';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { cn } from '@/lib/utils';
import { AiHeaderIconButton } from './ai-header-icon-button';

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

interface DiffPreviewLine {
  readonly kind: 'added' | 'removed' | 'hunk' | 'meta' | 'context';
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

interface ParsedUnifiedDiff {
  readonly lines: readonly DiffPreviewLine[];
  readonly addedCount: number;
  readonly removedCount: number;
}

function normalizeCheckpointPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function splitCheckpointPath(targetPath: string): { readonly fileName: string; readonly dirPath: string } {
  const slashIndex = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'));
  if (slashIndex < 0) {
    return { fileName: targetPath, dirPath: '' };
  }
  const fileName = targetPath.slice(slashIndex + 1) || targetPath;
  const dirPath = slashIndex === 0 ? targetPath.slice(0, 1) : targetPath.slice(0, slashIndex);
  return { fileName, dirPath };
}

function formatCheckpointTime(unixMs: number, locale?: string): string {
  if (!Number.isFinite(unixMs) || unixMs <= 0) return '';
  try {
    return new Date(unixMs).toLocaleTimeString(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnifiedDiff(unifiedDiff: string): ParsedUnifiedDiff {
  const rawLines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const lines: DiffPreviewLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let addedCount = 0;
  let removedCount = 0;

  for (const text of rawLines) {
    const hunkMatch = HUNK_HEADER_RE.exec(text);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      lines.push({ kind: 'hunk', oldLine: null, newLine: null, text });
      continue;
    }
    if (
      text.startsWith('--- ')
      || text.startsWith('+++ ')
      || text.startsWith('diff --git ')
      || text.startsWith('index ')
      || text.startsWith('\\ ')
    ) {
      lines.push({ kind: 'meta', oldLine: null, newLine: null, text });
      continue;
    }
    if (text.startsWith('+')) {
      addedCount += 1;
      lines.push({ kind: 'added', oldLine: null, newLine, text });
      if (newLine !== null) newLine += 1;
      continue;
    }
    if (text.startsWith('-')) {
      removedCount += 1;
      lines.push({ kind: 'removed', oldLine, newLine: null, text });
      if (oldLine !== null) oldLine += 1;
      continue;
    }
    lines.push({ kind: 'context', oldLine, newLine, text });
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
  }

  return { lines, addedCount, removedCount };
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
  const { t, locale } = useI18n();
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

  const parsedDiff = useMemo<ParsedUnifiedDiff | null>(() => {
    if (!preview || preview.unchanged || preview.isBinary) return null;
    return parseUnifiedDiff(preview.unifiedDiff);
  }, [preview]);

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

  const activePathParts = activeCheckpoint ? splitCheckpointPath(activeCheckpoint.targetPath) : null;
  const triggerLabel = t('ai.checkpointRollback.buttonWithCount', { count: checkpoints.length });

  return (
    <>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={(
            <AiHeaderIconButton
              type="button"
              badgeCount={checkpoints.length}
              badgeTone="neutral"
              aria-label={triggerLabel}
              data-testid="file-checkpoint-rollback-trigger"
              onClick={() => handleOpenChange(true)}
            />
          )}
        >
          <FileDiffIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{triggerLabel}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <CompactDialogContent className="h-[min(78vh,640px)] w-[min(58rem,calc(100vw-2rem))] max-w-none">
          <CompactDialogHeader
            title={t('ai.checkpointRollback.title')}
            description={t('ai.checkpointRollback.description')}
          />
          <div className="flex min-h-0 flex-1 flex-col px-4 pt-3 pb-2">
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(150px,38%)_minmax(0,1fr)] divide-y divide-app-border/70 overflow-hidden rounded-lg border border-app-border/80 bg-background sm:grid-cols-[276px_minmax(0,1fr)] sm:grid-rows-1 sm:divide-x sm:divide-y-0">
              <div className="flex min-h-0 min-w-0 flex-col bg-muted/15">
                <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-app-border/60 bg-muted/30 px-3">
                  <span className="truncate text-xs font-medium tabular-nums text-muted-foreground">
                    {selectedIds.length > 0
                      ? t('ai.checkpointRollback.selectedCount', {
                          selected: selectedIds.length,
                          total: checkpoints.length,
                        })
                      : t('ai.checkpointRollback.listCount', { count: checkpoints.length })}
                  </span>
                  {unrestoredIds.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      disabled={loading || restoring}
                      onClick={handleToggleSelectAll}
                    >
                      {t(allUnrestoredSelected ? 'ai.checkpointRollback.clearSelection' : 'ai.checkpointRollback.selectAll')}
                    </Button>
                  )}
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col gap-1 p-2">
                    {loading && checkpoints.length === 0 ? (
                      <p className="p-3 text-center text-xs text-muted-foreground">
                        {t('ai.checkpointRollback.loading')}
                      </p>
                    ) : checkpoints.map((item) => {
                      const selected = item.checkpointId === activeId;
                      const checked = selectedIds.includes(item.checkpointId);
                      const { fileName, dirPath } = splitCheckpointPath(item.targetPath);
                      const timeLabel = formatCheckpointTime(item.createdAtUnixMs, locale);
                      const isModified = Boolean(item.originalSha256);

                      return (
                        <div
                          key={item.checkpointId}
                          data-active={selected || undefined}
                          className={cn(
                            'flex items-start gap-2 rounded-md border px-2.5 py-2 transition-colors',
                            selected
                              ? 'border-app-border bg-background shadow-2xs'
                              : 'border-transparent hover:bg-muted/50',
                          )}
                        >
                          <Checkbox
                            aria-label={item.targetPath}
                            checked={checked}
                            disabled={restoring}
                            className="mt-0.5 shrink-0"
                            onCheckedChange={(next) => toggleSelection(item.checkpointId, Boolean(next))}
                          />
                          <button
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setActiveId(item.checkpointId)}
                            className="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-xs"
                          >
                            <span className="flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                                {fileName}
                              </span>
                              {timeLabel && (
                                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                  {timeLabel}
                                </span>
                              )}
                            </span>
                            {dirPath && (
                              <span
                                className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
                                title={item.targetPath}
                              >
                                {item.targetPath}
                              </span>
                            )}
                            <span className="flex flex-wrap items-center gap-1 pt-0.5">
                              <Badge
                                variant="outline"
                                size="sm"
                                className={cn(
                                  isModified
                                    ? 'border-app-warning/35 bg-app-warning/10 text-app-warning'
                                    : 'border-app-success/35 bg-app-success/10 text-app-success',
                                )}
                              >
                                {t(isModified ? 'ai.checkpointRollback.badgeModified' : 'ai.checkpointRollback.badgeCreated')}
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

              <div className="flex min-h-0 min-w-0 flex-col bg-background">
                {activeCheckpoint && activePathParts && (
                  <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-app-border/60 bg-muted/30 px-3 py-1.5">
                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="shrink-0 text-xs font-medium text-foreground">
                        {activePathParts.fileName}
                      </span>
                      {activePathParts.dirPath && (
                        <span
                          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                          title={activeCheckpoint.targetPath}
                        >
                          {activePathParts.dirPath}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!previewLoading && parsedDiff && (parsedDiff.addedCount > 0 || parsedDiff.removedCount > 0) && (
                        <span
                          className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium tabular-nums"
                          data-testid="file-checkpoint-diff-stats"
                        >
                          {parsedDiff.addedCount > 0 && (
                            <span className="text-app-success">+{parsedDiff.addedCount}</span>
                          )}
                          {parsedDiff.removedCount > 0 && (
                            <span className="text-destructive">-{parsedDiff.removedCount}</span>
                          )}
                        </span>
                      )}
                      {!previewLoading && preview?.modifiedAfterAgent && !preview.unchanged && (
                        <Badge variant="destructive" size="sm">
                          {t('ai.checkpointRollback.badgeConflict')}
                        </Badge>
                      )}
                      <Badge variant="outline" size="sm" className="text-muted-foreground">
                        {t(activeCheckpoint.targetKind === 'remote'
                          ? 'ai.checkpointRollback.targetRemote'
                          : 'ai.checkpointRollback.targetLocal')}
                      </Badge>
                    </div>
                  </div>
                )}

                {previewLoading ? (
                  <PanelLoadingState label={t('ai.checkpointRollback.previewLoading')} />
                ) : !preview ? (
                  <PanelEmptyState size="sm" title={t('ai.checkpointRollback.selectPrompt')} />
                ) : preview.unchanged ? (
                  <PanelEmptyState size="sm" title={t('ai.checkpointRollback.unchanged')} />
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {preview.modifiedAfterAgent && (
                      <div className="shrink-0 px-3 pt-3 pb-2">
                        <Alert variant="destructive" size="sm" data-testid="file-checkpoint-conflict-alert">
                          <AlertTriangleIcon aria-hidden="true" />
                          <AlertDescription>
                            {t('ai.checkpointRollback.conflictBanner')}
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}
                    {preview.isBinary ? (
                      <PanelEmptyState size="sm" title={t('ai.checkpointRollback.binaryPreview')} />
                    ) : (
                      <>
                        {preview.truncated && (
                          <div className="shrink-0 border-b border-app-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
                            {t('ai.checkpointRollback.truncatedDiff')}
                          </div>
                        )}
                        <ScrollArea horizontal className="min-h-0 flex-1">
                          <div
                            className="table min-w-full pb-2 font-mono text-[11.5px] leading-5"
                            data-testid="file-checkpoint-diff-viewer"
                          >
                            {(parsedDiff?.lines ?? []).map((line, idx) => (
                              <div
                                key={idx}
                                data-diff-line={line.kind}
                                className={cn(
                                  'table-row',
                                  line.kind === 'added' && 'bg-app-success/10 text-app-success',
                                  line.kind === 'removed' && 'bg-destructive/10 text-destructive',
                                  line.kind === 'hunk' && 'bg-muted/50 text-muted-foreground',
                                  line.kind === 'meta' && 'bg-muted/25 text-muted-foreground',
                                  line.kind === 'context' && 'text-foreground/85',
                                )}
                              >
                                <span
                                  aria-hidden="true"
                                  className="table-cell w-[1%] min-w-9 select-none pl-2.5 pr-2 text-right text-[11px] tabular-nums opacity-55"
                                >
                                  {line.oldLine ?? ''}
                                </span>
                                <span
                                  aria-hidden="true"
                                  className="table-cell w-[1%] min-w-9 select-none border-r border-app-border/50 pr-2 text-right text-[11px] tabular-nums opacity-55"
                                >
                                  {line.newLine ?? ''}
                                </span>
                                <span className="table-cell whitespace-pre px-3">
                                  {line.text || '\u00a0'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <CompactDialogFooter className="flex-row items-center justify-between sm:justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || restoring}
              onClick={() => void loadList(true)}
            >
              {t('ai.checkpointRollback.refresh')}
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {selectedIds.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={restoring}
                  data-testid="file-checkpoint-batch-restore"
                  onClick={() => setBatchConfirm({ checkpointIds: selectedIds, conflictOverwrite: false })}
                >
                  {t('ai.checkpointRollback.batchRestore', { count: selectedIds.length })}
                </Button>
              )}
              <Button
                type="button"
                variant={preview?.modifiedAfterAgent ? 'destructive' : 'default'}
                size="sm"
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
                {t(restoring ? 'ai.checkpointRollback.restoring' : 'ai.checkpointRollback.restore')}
              </Button>
            </div>
          </CompactDialogFooter>
        </CompactDialogContent>
      </Dialog>
      <ConfirmationDialog
        textOnlyActions
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
        textOnlyActions
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
