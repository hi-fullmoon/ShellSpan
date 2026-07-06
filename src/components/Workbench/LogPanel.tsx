import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useLogStore } from '@/stores/logStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, Spinner } from '@/components/ui/EmptyState';
import { cn, formatBytes } from '@/lib/utils';

export const LogPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    files,
    activeFileName,
    content,
    loading,
    loadFiles,
    loadFile,
    refreshActiveFile,
  } = useLogStore();
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!activeFileName) return;
    const timer = setInterval(() => {
      refreshActiveFile();
    }, 2000);
    return () => clearInterval(timer);
  }, [activeFileName, refreshActiveFile]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, autoScroll]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center justify-between border-b border-app-border px-3">
        <span className="text-sm font-medium text-app-text">
          {t('workbench.logs.title')}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-app-text-soft">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded border-app-border"
            />
            {t('workbench.logs.autoScroll')}
          </label>
          <Button variant="secondary" size="sm" onClick={loadFiles}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-48 shrink-0 overflow-y-auto border-r border-app-border">
          {files.length === 0 && !loading && (
            <EmptyState title={t('workbench.logs.empty')} />
          )}
          {files.map((file) => (
            <button
              key={file.name}
              onClick={() => loadFile(file.name)}
              className={cn(
                'flex w-full flex-col items-start border-b border-app-border px-3 py-2 text-left hover:bg-app-surface-muted',
                activeFileName === file.name && 'bg-app-surface-muted',
              )}
            >
              <span className="text-xs font-medium text-app-text">
                {file.name}
              </span>
              <span className="text-[10px] text-app-text-soft">
                {formatBytes(file.size)}
              </span>
            </button>
          ))}
        </div>
        <div className="relative flex flex-1 flex-col">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-bg/80">
              <Spinner />
            </div>
          )}
          <pre
            ref={scrollRef}
            className="flex-1 overflow-auto p-3 font-mono text-xs text-app-text"
          >
            {content || (
              <span className="text-app-text-soft">
                {t('workbench.logs.empty')}
              </span>
            )}
          </pre>
        </div>
      </div>
    </div>
  );
};
