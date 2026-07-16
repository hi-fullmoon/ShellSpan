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
import { invokeExportLogFile } from '@/lib/tauri';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  onDoubleClick: () => void;
}

const LogLine: React.FC<LogLineProps> = ({ line, originalIndex, onDoubleClick }) => {
  if (!line.level || !line.message) {
    return (
      <button
        type="button"
        onDoubleClick={onDoubleClick}
        className="w-full cursor-pointer px-1 py-0.5 text-left text-app-text-soft transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50"
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
      onDoubleClick={onDoubleClick}
      className="grid w-full cursor-pointer grid-cols-[110px_2.75rem_1fr] items-start gap-2 px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50 md:grid-cols-[110px_2.75rem_4.5rem_1fr]"
    >
      <span className="shrink-0 whitespace-nowrap text-[10px] text-app-text-soft">
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
        <TooltipTrigger
          render={
            <span className="hidden truncate text-[10px] text-app-text-soft md:block" />
          }
        >
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
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('today');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const parsedLines = useMemo(() => parseLogContent(content), [content]);

  const today = useMemo(() => new Date(), []);

  const filteredLines = useMemo(() => {
    return parsedLines
      .map((line, index) => ({
        line,
        originalIndex: index,
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

  const handleExport = useCallback(async (): Promise<void> => {
    if (!content) return;
    const defaultName = activeFileName ?? 'termbridge-logs.txt';
    try {
      const savedPath = await invokeExportLogFile(defaultName, content);
      if (savedPath) {
        success(t('workbench.logs.exported', { path: savedPath }));
      }
    } catch {
      showError(t('workbench.logs.exportFailed'));
    }
  }, [content, activeFileName, success, showError, t]);

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
              <span className="text-xs text-muted-foreground">{activeFileName}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Label className="flex items-center gap-1 text-xs text-muted-foreground">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(checked) => setAutoScroll(checked === true)}
              />
              {t('workbench.logs.autoScroll')}
            </Label>
            <Button variant="secondary" size="sm" onClick={handleRefresh}>
              {t('common.refresh')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExport}
              disabled={!content}
            >
              {t('workbench.logs.export')}
            </Button>
          </div>
        </div>
        <div className="flex h-9 items-center gap-4 border-t border-app-border px-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.date')}
            </span>
            <Select
              value={dateFilter}
              onValueChange={(value) => setDateFilter(value as DateFilterOption)}
            >
              <SelectTrigger size="sm" className="w-32" data-testid="date-filter-trigger">
                <SelectValue>
                  {(value: unknown) => {
                    const option = DATE_FILTER_OPTIONS.find(
                      (opt) => opt.key === value,
                    );
                    return option ? t(option.labelKey) : String(value ?? '');
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DATE_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.level')}
            </span>
            <Select
              value={levelFilter}
              onValueChange={(value) => setLevelFilter(value as LogLevel | 'all')}
            >
              <SelectTrigger size="sm" className="w-24" data-testid="level-filter-trigger">
                <SelectValue>
                  {(value: unknown) =>
                    value === 'all'
                      ? t('workbench.logs.all')
                      : String(value ?? '')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('workbench.logs.all')}</SelectItem>
                {LOG_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <Spinner />
          </div>
        )}
        <ScrollArea
          className="min-h-0 flex-1 font-mono text-xs"
          viewportRef={scrollRef}
        >
          <div className="p-3">
            {filteredLines.length > 0 ? (
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
                      <LogLine
                        line={line}
                        originalIndex={originalIndex}
                        onDoubleClick={() => copyLogContent(line.raw)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <span className="text-muted-foreground">
                {t(content ? 'workbench.logs.noMatches' : 'workbench.logs.empty')}
              </span>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
