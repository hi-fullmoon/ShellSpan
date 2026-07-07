import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/hooks/useI18n';
import { useLogStore } from '@/stores/logStore';
import { Button } from '@/components/ui/Button';
import { EmptyState, Spinner } from '@/components/ui/EmptyState';
import { Tooltip } from '@/components/ui/Tooltip';
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
  return content.split('\n').map(parseLogLine);
}

function getTodayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

const LogLine: React.FC<{ line: ParsedLogLine; originalIndex: number }> = ({
  line,
  originalIndex,
}) => {
  if (!line.level || !line.message) {
    return (
      <div className="col-span-3 whitespace-pre-wrap break-all py-0.5 text-app-text-soft md:col-span-4">
        {line.raw}
      </div>
    );
  }

  const time = line.time ?? '';
  const shortTime = time.split('.')[0];
  const tooltip = line.target
    ? `${line.target} (line ${originalIndex + 1})`
    : `line ${originalIndex + 1}`;

  return (
    <div className="grid grid-cols-[120px_2.75rem_1fr] items-start gap-2 py-0.5 md:grid-cols-[120px_2.75rem_4.5rem_1fr]">
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
      <Tooltip
        content={tooltip}
        className="hidden truncate text-[10px] text-app-text-soft md:block"
      >
        {line.target ? line.target.split('::').pop() : ''}
      </Tooltip>
      <span className="min-w-0 whitespace-pre-wrap break-all text-app-text">
        {line.message}
      </span>
    </div>
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
        'rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors',
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
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('today');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const parsedLines = useMemo(() => parseLogContent(content), [content]);

  const today = useMemo(() => new Date(), []);

  const filteredLines = useMemo(() => {
    return parsedLines
      .map((line, index) => ({ line, originalIndex: index }))
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
            <label className="flex items-center gap-1 text-xs text-app-text-soft">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-app-border"
              />
              {t('workbench.logs.autoScroll')}
            </label>
            <Button variant="secondary" size="sm" onClick={handleRefresh}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
        <div className="flex h-8 items-center gap-4 border-t border-app-border px-3">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-app-text-soft">
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
            <span className="text-[10px] text-app-text-soft">
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
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto p-3 font-mono text-xs"
        >
          {content ? (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualItem) => {
                const { line, originalIndex } = filteredLines[virtualItem.index];
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
                    <LogLine line={line} originalIndex={originalIndex} />
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="text-app-text-soft">{t('workbench.logs.empty')}</span>
          )}
        </div>
      </div>
    </div>
  );
};
