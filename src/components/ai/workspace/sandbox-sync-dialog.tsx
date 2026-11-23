import React, { useCallback, useEffect, useState } from 'react';
import { FolderSyncIcon, RefreshCwIcon, AlertTriangleIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  invokeSandboxApply,
  invokeSandboxDiff,
  invokeSandboxFileDiff,
  type SandboxDiffReport,
  type SandboxFileDiffPreview,
} from '@/lib/ipc/tauri';

interface SandboxSyncDialogProps {
  readonly sessionId: string;
}

export function SandboxSyncDialog({ sessionId }: SandboxSyncDialogProps): React.ReactElement | null {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<SandboxDiffReport | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [allowOverwriteConflicts, setAllowOverwriteConflicts] = useState(false);
  const [applyErrors, setApplyErrors] = useState<readonly string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<SandboxFileDiffPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadPreview = useCallback(async (path: string) => {
    setActivePath(path);
    setPreviewLoading(true);
    try {
      const next = await invokeSandboxFileDiff(sessionId, path);
      setPreview(next);
    } catch {
      setPreview(null);
      showError(t('ai.sandboxSync.previewFailed'));
    } finally {
      setPreviewLoading(false);
    }
  }, [sessionId, showError, t]);

  const loadDiff = useCallback(async (showFailureToast: boolean) => {
    setLoading(true);
    try {
      const next = await invokeSandboxDiff(sessionId);
      setReport(next);
      setAvailable(next !== null);
      if (next) {
        if (next.conflictCount === 0) {
          setAllowOverwriteConflicts(false);
        }
        setSelected(new Set(next.changes.filter((item) => !item.conflict).map((item) => item.path)));
        setActivePath((current) => {
          if (current && next.changes.some((item) => item.path === current)) return current;
          return null;
        });
        setPreview(null);
      } else {
        setAllowOverwriteConflicts(false);
        setApplyErrors([]);
        setSelected(new Set());
        setActivePath(null);
        setPreview(null);
      }
    } catch {
      if (showFailureToast) showError(t('ai.sandboxSync.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [sessionId, showError, t]);

  useEffect(() => {
    void loadDiff(false);
  }, [loadDiff]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setApplyErrors([]);
      void loadDiff(true);
    }
  };

  const togglePath = (path: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const handleToggleOverwriteConflicts = (checked: boolean) => {
    setAllowOverwriteConflicts(checked);
    if (!checked && report) {
      const conflictPaths = new Set(report.changes.filter((item) => item.conflict).map((item) => item.path));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const path of conflictPaths) next.delete(path);
        return next;
      });
    }
  };

  const handleApply = async () => {
    if (!report || selected.size === 0 || applying) return;
    setApplying(true);
    setApplyErrors([]);
    const hasSelectedConflicts = report.changes.some((item) => item.conflict && selected.has(item.path));
    try {
      const result = await invokeSandboxApply({
        sessionId,
        paths: [...selected],
        allowOverwriteConflicts: allowOverwriteConflicts && hasSelectedConflicts,
      });
      if (result.errors.length > 0) {
        setApplyErrors(result.errors);
      } else if (result.applied.length > 0) {
        showSuccess(t('ai.sandboxSync.applySuccess', { count: result.applied.length }));
      }
      await loadDiff(false);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const translated = aiErrorMessage(raw, t);
      showError(translated !== raw ? translated : t('ai.sandboxSync.applyFailed'));
    } finally {
      setApplying(false);
    }
  };

  if (!available) return null;

  const pendingCount = report?.totalChanges ?? 0;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        aria-label={pendingCount > 0
          ? t('ai.sandboxSync.triggerWithCount', { count: pendingCount })
          : t('ai.sandboxSync.trigger')}
        onClick={() => handleOpenChange(true)}
      >
        <FolderSyncIcon className="size-3.5 shrink-0" />
        <span className="hidden truncate @min-[420px]/ai-workspace:inline">
          {pendingCount > 0
            ? t('ai.sandboxSync.triggerWithCount', { count: pendingCount })
            : t('ai.sandboxSync.trigger')}
        </span>
        {pendingCount > 0 && (
          <span className="tabular-nums @min-[420px]/ai-workspace:hidden" aria-hidden="true">
            {pendingCount}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('ai.sandboxSync.title')}</DialogTitle>
            <DialogDescription>
              {report ? t('ai.sandboxSync.description', { sourceRoot: report.sourceRoot }) : t('ai.sandboxSync.loading')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {report && report.conflictCount > 0 && (
              <Alert variant="destructive" className="shrink-0">
                <AlertTriangleIcon className="size-4" />
                <AlertDescription className="flex flex-col gap-2">
                  <span>{t('ai.sandboxSync.conflictNotice', { count: report.conflictCount })}</span>
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                    <Checkbox
                      checked={allowOverwriteConflicts}
                      disabled={applying}
                      onCheckedChange={(value) => handleToggleOverwriteConflicts(value === true)}
                    />
                    <span>{t('ai.sandboxSync.allowOverwriteConflicts')}</span>
                  </label>
                </AlertDescription>
              </Alert>
            )}

            {applyErrors.length > 0 && (
              <Alert variant="destructive" className="shrink-0">
                <AlertTriangleIcon className="size-4" />
                <AlertDescription className="flex flex-col gap-1">
                  <span>{t('ai.sandboxSync.applyErrorsTitle')}</span>
                  <ul className="list-disc pl-4 font-mono text-[11px]">
                    {applyErrors.map((item) => (
                      <li key={item} className="break-all">{item}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
              <ScrollArea className="min-h-0 rounded-md border">
                <div className="flex flex-col gap-1 p-2">
                  {loading && !report ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {t('ai.sandboxSync.loading')}
                    </p>
                  ) : !report || report.changes.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {t('ai.sandboxSync.empty')}
                    </p>
                  ) : (
                    report.changes.map((change) => {
                      const checked = selected.has(change.path);
                      const isActive = activePath === change.path;
                      return (
                        <div
                          key={change.path}
                          className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${isActive ? 'bg-muted' : 'hover:bg-muted/50'}`}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={(change.conflict && !allowOverwriteConflicts) || applying}
                            aria-label={change.path}
                            onCheckedChange={(value) => togglePath(change.path, value === true)}
                          />
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1 text-left"
                            onClick={() => void loadPreview(change.path)}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {t(`ai.sandboxSync.kind.${change.kind}`)}
                            </Badge>
                            {change.conflict && (
                              <Badge variant="destructive" className="shrink-0 text-[10px]">
                                {t('ai.sandboxSync.conflictBadge')}
                              </Badge>
                            )}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              <ScrollArea className="min-h-0 rounded-md border bg-muted/20">
                <div className="p-2 font-mono text-[11px] leading-5">
                  {previewLoading ? (
                    <p className="py-6 text-center font-sans text-xs text-muted-foreground">
                      {t('ai.sandboxSync.previewLoading')}
                    </p>
                  ) : !activePath || !preview ? (
                    <p className="py-6 text-center font-sans text-xs text-muted-foreground">
                      {t('ai.sandboxSync.previewPlaceholder')}
                    </p>
                  ) : preview.isBinary ? (
                    <p className="py-6 text-center font-sans text-xs text-muted-foreground">
                      {t('ai.sandboxSync.previewBinary')}
                    </p>
                  ) : (
                    <>
                      {preview.truncated && (
                        <p className="mb-2 font-sans text-xs text-muted-foreground">
                          {t('ai.sandboxSync.previewTruncated')}
                        </p>
                      )}
                      <pre className="whitespace-pre-wrap break-all">
                        {preview.unifiedDiff.split('\n').map((line, idx) => {
                          const tone = line.startsWith('+') && !line.startsWith('+++')
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : line.startsWith('-') && !line.startsWith('---')
                              ? 'bg-destructive/10 text-destructive'
                              : line.startsWith('@@')
                                ? 'text-muted-foreground'
                                : '';
                          return (
                            <div key={idx} className={tone ? `px-1 ${tone}` : 'px-1'}>
                              {line || ' '}
                            </div>
                          );
                        })}
                      </pre>
                    </>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter className="shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={loading || applying}
              onClick={() => void loadDiff(true)}
            >
              <RefreshCwIcon className="size-3.5" />
              <span>{t('ai.sandboxSync.refresh')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={loading || applying || selected.size === 0}
              onClick={() => void handleApply()}
            >
              {applying
                ? t('ai.sandboxSync.applying')
                : t('ai.sandboxSync.apply', { count: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
