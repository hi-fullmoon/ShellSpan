import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/hooks/useI18n';
import { useLogStore } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/empty-state';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';

interface ParsedLogLine {
  raw: string;
  date?: string;
  time?: string;
  level?: string;
  target?: string;
  message?: string;
}

const DATE_FILTER_OPTIONS = [
  { key: 'today', labelKey: 'workbench.logs.today' },
  { key: 'last3days', labelKey: 'workbench.logs.last3days' },
  { key: 'last7days', labelKey: 'workbench.logs.last7days' },
  { key: 'last30days', labelKey: 'workbench.logs.last30days' },
  { key: 'all', labelKey: 'workbench.logs.all' },
] as const;

type DateFilterOption = (typeof DATE_FILTER_OPTIONS)[number]['key'];

const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LINE_REGEX =
  /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\[(DEBUG|INFO|WARN|ERROR)\](?:\[(.*?)\])?\s*(.*)$/;

function parseLogLine(line: string): ParsedLogLine {
  const match = LOG_LINE_REGEX.exec(line);
  if (!match) {
    return { raw: line };
  }

  return {
    raw: line,
    date: match[1],
    time: match[2],
    level: match[3],
    target: match[4],
    message: match[5],
  };
}

function parseLogContent(content: string): ParsedLogLine[] {
  if (!content) return [];

  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map(parseLogLine);
}

function getDaysDifference(dateString: string, today: Date): number {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const diffTime = todayMidnight.getTime() - date.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

function matchesDateFilter(
  lineDate: string | undefined,
  filter: DateFilterOption,
  today: Date,
): boolean {
  if (filter === 'all' || !lineDate) {
    return true;
  }
  const diff = getDaysDifference(lineDate, today);
  if (diff < 0 || diff > 29) {
    return false;
  }
  switch (filter) {
    case 'today':
      return diff === 0;
    case 'last3days':
      return diff <= 2;
    case 'last7days':
      return diff <= 6;
    case 'last30days':
      return diff <= 29;
    default:
      return true;
  }
}

function getLevelClasses(level: string): string {
  switch (level) {
    case 'ERROR':
      return 'bg-app-error/10 text-app-error';
    case 'WARN':
      return 'bg-app-warning/10 text-app-warning';
    case 'DEBUG':
      return 'bg-app-primary/10 text-app-primary';
    case 'INFO':
    default:
      return 'bg-app-success/10 text-app-success';
  }
}

interface LogLineProps {
  line: ParsedLogLine;
  originalIndex: number;
  selected: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick: () => void;
}

const LogLine: React.FC<LogLineProps> = ({
  line,
  originalIndex,
  selected,
  onClick,
  onDoubleClick,
}) => {
  if (!line.level || !line.message) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={cn(
          'w-full cursor-pointer px-1 py-0.5 text-left text-app-text-soft transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50',
          selected && 'bg-app-primary/10',
        )}
      >
        {line.raw}
      </button>
    );
  }

  const time = line.time ?? '';
  const shortTime = time.split('.')[0];
  const tooltip = line.target
    ? `${line.target} (line ${originalIndex + 1})`
    : `line ${originalIndex + 1}`;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[120px_2.75rem_1fr] items-start gap-2 px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50 md:grid-cols-[120px_2.75rem_4.5rem_1fr]',
        selected && 'bg-app-primary/10',
      )}
    >
      <span className="shrink-0 text-[10px] text-app-text-soft">
        {line.date} {shortTime}
      </span>
      <span
        className={cn(
          'inline-flex h-4 shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold uppercase',
          getLevelClasses(line.level),
        )}
      >
        {line.level}
      </span>
      <Tooltip>
        <TooltipTrigger className="hidden truncate text-[10px] text-app-text-soft md:block">
          {line.target ? line.target.split('::').pop() : ''}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <span className="min-w-0 whitespace-pre-wrap break-all text-app-text">
        {line.message}
      </span>
    </button>
  );
};

interface FilterButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const FilterButton: React.FC<FilterButtonProps> = ({
  active,
  onClick,
  children,
}) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? 'bg-app-surface text-app-primary shadow-sm'
          : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
      )}
    >
      {children}
    </button>
  );
};

export const LogPanel: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToast();
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
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('all');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedLineKeys, setSelectedLineKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const singleClickTimerRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const parsedLines = useMemo(() => parseLogContent(content), [content]);

  const today = useMemo(() => new Date(), []);

  const filteredLines = useMemo(() => {
    return parsedLines
      .map((line, index) => ({
        line,
        originalIndex: index,
        selectionKey: `${index}\u0000${line.raw}`,
      }))
      .filter(({ line }) => {
        if (!matchesDateFilter(line.date, dateFilter, today)) {
          return false;
        }
        if (levelFilter !== 'all' && line.level !== levelFilter) {
          return false;
        }
        return true;
      });
  }, [parsedLines, dateFilter, levelFilter, today]);

  const virtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 20,
  });

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleCopySelectedLogs = useCallback((): void => {
    const selectedLogs = parsedLines
      .map((line, index) => ({
        raw: line.raw,
        selectionKey: `${index}\u0000${line.raw}`,
      }))
      .filter(({ selectionKey }) => selectedLineKeys.has(selectionKey))
      .map(({ raw }) => raw);

    if (selectedLogs.length === 0) return;

    if (!navigator.clipboard?.writeText) {
      showError(t('workbench.logs.copyFailed'));
      return;
    }
    void navigator.clipboard
      .writeText(selectedLogs.join('\n'))
      .then(() => success(t('workbench.logs.copied')))
      .catch(() => showError(t('workbench.logs.copyFailed')));
  }, [parsedLines, selectedLineKeys, success, showError, t]);

  const copyLogContent = useCallback(
    (contentToCopy: string): void => {
      if (!navigator.clipboard?.writeText) {
        showError(t('workbench.logs.copyFailed'));
        return;
      }
      void navigator.clipboard
        .writeText(contentToCopy)
        .then(() => success(t('workbench.logs.copied')))
        .catch(() => showError(t('workbench.logs.copyFailed')));
    },
    [success, showError, t],
  );

  const clearPendingSingleClick = useCallback((): void => {
    if (singleClickTimerRef.current !== null) {
      window.clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
    }
  }, []);

  const handleSelectLine = useCallback(
    (
      selectionKey: string,
      filteredIndex: number,
      shiftKey: boolean,
      additiveKey: boolean,
    ): void => {
      const anchorIndex = selectionAnchorRef.current
        ? filteredLines.findIndex(
            (item) => item.selectionKey === selectionAnchorRef.current,
          )
        : -1;

      if (shiftKey && anchorIndex >= 0) {
        const start = Math.min(anchorIndex, filteredIndex);
        const end = Math.max(anchorIndex, filteredIndex);
        setSelectedLineKeys(
          new Set(
            filteredLines
              .slice(start, end + 1)
              .filter(({ line }) => Boolean(line.raw))
              .map((item) => item.selectionKey),
          ),
        );
        return;
      }

      selectionAnchorRef.current = selectionKey;
      if (additiveKey) {
        setSelectedLineKeys((current) => {
          const next = new Set(current);
          if (next.has(selectionKey)) {
            next.delete(selectionKey);
          } else {
            next.add(selectionKey);
          }
          return next;
        });
        return;
      }

      setSelectedLineKeys(new Set([selectionKey]));
    },
    [filteredLines],
  );

  const handleSelectAll = useCallback((): void => {
    setSelectedLineKeys((current) => {
      const next = new Set(current);
      filteredLines.forEach(({ line, selectionKey }) => {
        if (line.raw) next.add(selectionKey);
      });
      return next;
    });
  }, [filteredLines]);

  const handleClearSelection = useCallback((): void => {
    clearPendingSingleClick();
    selectionAnchorRef.current = null;
    setSelectedLineKeys(new Set());
    setSelectionMode(false);
  }, [clearPendingSingleClick]);

  useEffect(() => {
    if (!selectionMode) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handleClearSelection();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClearSelection, selectionMode]);

  useEffect(() => {
    return () => {
      clearPendingSingleClick();
    };
  }, [clearPendingSingleClick]);

  useEffect(() => {
    selectionAnchorRef.current = null;
    setSelectedLineKeys(new Set());
    setSelectionMode(false);
  }, [activeFileName]);

  useEffect(() => {
    const availableLineKeys = new Set(
      parsedLines.map((line, index) => `${index}\u0000${line.raw}`),
    );
    if (
      selectionAnchorRef.current &&
      !availableLineKeys.has(selectionAnchorRef.current)
    ) {
      selectionAnchorRef.current = null;
    }
    setSelectedLineKeys((current) => {
      const next = new Set(
        [...current].filter((selectionKey) =>
          availableLineKeys.has(selectionKey),
        ),
      );
      if (next.size === current.size) return current;
      return next;
    });
  }, [parsedLines]);

  useEffect(() => {
    if (files.length > 0 && !activeFileName) {
      void loadFile(files[0].name);
    }
  }, [files, activeFileName, loadFile]);

  useEffect(() => {
    if (!activeFileName) return;
    const timer = setInterval(() => {
      refreshActiveFile();
    }, 2000);
    return () => clearInterval(timer);
  }, [activeFileName, refreshActiveFile]);

  useEffect(() => {
    if (autoScroll && filteredLines.length > 0) {
      virtualizer.scrollToIndex(filteredLines.length - 1, { align: 'end' });
    }
  }, [filteredLines.length, autoScroll, virtualizer]);

  const handleRefresh = (): void => {
    void loadFiles().then(() => {
      if (activeFileName) {
        void refreshActiveFile();
      }
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-app-border">
        <div className="flex h-9 items-center justify-between px-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-app-text">
              {t('workbench.logs.title')}
            </span>
            {activeFileName && (
              <span className="text-xs text-app-text-soft">{activeFileName}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Label className="flex items-center gap-1 text-xs text-app-text-soft">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(checked) => setAutoScroll(checked === true)}
              />
              {t('workbench.logs.autoScroll')}
            </Label>
            <Button variant="secondary" size="sm" onClick={handleRefresh}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
        <div className="flex h-8 items-center gap-4 border-t border-app-border px-3">
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-app-text-soft">
              {t('workbench.logs.date')}
            </span>
            {DATE_FILTER_OPTIONS.map((option) => (
              <FilterButton
                key={option.key}
                active={dateFilter === option.key}
                onClick={() => setDateFilter(option.key)}
              >
                {t(option.labelKey)}
              </FilterButton>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-app-text-soft">
              {t('workbench.logs.level')}
            </span>
            <FilterButton
              active={levelFilter === 'all'}
              onClick={() => setLevelFilter('all')}
            >
              {t('workbench.logs.all')}
            </FilterButton>
            {LOG_LEVELS.map((level) => (
              <FilterButton
                key={level}
                active={levelFilter === level}
                onClick={() => setLevelFilter(level)}
              >
                {level}
              </FilterButton>
            ))}
          </div>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-bg/80">
            <Spinner />
          </div>
        )}
        {selectionMode && (
          <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-2 py-1.5 shadow-[var(--shadow-dialog)]">
            <span className="whitespace-nowrap px-1 text-xs font-medium text-app-text">
              {t('workbench.logs.selectedCount', {
                count: selectedLineKeys.size,
              })}
            </span>
            <span className="mx-1 h-4 w-px bg-app-border" />
            <Button variant="ghost" size="sm" onClick={handleSelectAll}>
              {t('workbench.logs.selectAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearSelection}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleCopySelectedLogs}
              disabled={selectedLineKeys.size === 0}
            >
              {t('common.copy')}
            </Button>
          </div>
        )}
        <div
          ref={scrollRef}
          className={cn(
            'min-h-0 flex-1 overflow-auto p-3 font-mono text-xs',
            selectionMode && 'pb-14',
          )}
        >
          {filteredLines.length > 0 ? (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualItem) => {
                const { line, originalIndex, selectionKey } =
                  filteredLines[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <LogLine
                      line={line}
                      originalIndex={originalIndex}
                      selected={selectedLineKeys.has(selectionKey)}
                      onClick={(event) => {
                        if (selectionMode) {
                          handleSelectLine(
                            selectionKey,
                            virtualItem.index,
                            event.shiftKey,
                            event.ctrlKey || event.metaKey,
                          );
                          return;
                        }
                        clearPendingSingleClick();
                        singleClickTimerRef.current = window.setTimeout(() => {
                          singleClickTimerRef.current = null;
                          copyLogContent(line.raw);
                        }, 250);
                      }}
                      onDoubleClick={() => {
                        clearPendingSingleClick();
                        selectionAnchorRef.current = selectionKey;
                        setSelectedLineKeys(new Set([selectionKey]));
                        setSelectionMode(true);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="text-app-text-soft">
              {t(content ? 'workbench.logs.noMatches' : 'workbench.logs.empty')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
