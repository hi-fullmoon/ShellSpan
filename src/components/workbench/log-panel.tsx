import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownToLineIcon,
  DownloadIcon,
  FileSearchIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useLogStore } from '@/stores/logStore';
import type { LogSource } from '@/types';
import { Button } from '@/components/ui/button';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { invokeExportLogFile } from '@/lib/tauri';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
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

  // A single log entry can span multiple physical lines (e.g. a stack trace
  // after an error header). Lines without a log header are continuations of
  // the previous entry and get merged into its message/raw so filtering,
  // search and copy all operate on the whole entry instead of fragments.
  const entries: ParsedLogLine[] = [];
  let current: ParsedLogLine | undefined;
  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (parsed.level) {
      current = parsed;
      entries.push(current);
    } else if (current) {
      current.message = `${current.message}\n${line}`;
      current.raw = `${current.raw}\n${line}`;
    } else {
      entries.push(parsed);
    }
  }
  return entries;
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

function renderHighlightedText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      nodes.push(text.slice(cursor));
      break;
    }
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex));
    }
    nodes.push(
      <mark
        key={key++}
        className="rounded-[2px] bg-app-warning/30 text-inherit"
      >
        {text.slice(matchIndex, matchIndex + lowerQuery.length)}
      </mark>,
    );
    cursor = matchIndex + lowerQuery.length;
  }
  return nodes;
}

interface LogLineProps {
  line: ParsedLogLine;
  originalIndex: number;
  query: string;
  onDoubleClick: () => void;
}

const LogLine: React.FC<LogLineProps> = ({
  line,
  originalIndex,
  query,
  onDoubleClick,
}) => {
  if (!line.level || !line.message) {
    return (
      <button
        type="button"
        onDoubleClick={onDoubleClick}
        className="flex w-full cursor-pointer items-start gap-2 px-2 py-1 text-left text-app-text-soft transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50"
      >
        <span className="min-w-0 whitespace-pre-wrap break-all">
          {renderHighlightedText(line.raw, query)}
        </span>
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
      className="flex w-full cursor-pointer items-start gap-2 px-2 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-primary/50"
    >
      <span className="w-[19ch] shrink-0 whitespace-nowrap text-[10px] leading-4 text-app-text-soft">
        {line.date} {shortTime}
      </span>
      <span
        className={cn(
          'inline-flex h-4 w-11 shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold uppercase',
          getLevelClasses(line.level),
        )}
      >
        {line.level}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="hidden w-28 shrink-0 truncate text-[10px] leading-4 text-app-text-soft md:block" />
          }
        >
          {line.target ? renderHighlightedText(line.target.split('::').pop() ?? '', query) : ''}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-app-text">
        {renderHighlightedText(line.message, query)}
      </span>
    </button>
  );
};

export const LogPanel: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToast();
  const {
    activeFileName,
    activeSource,
    content,
    loading,
    loadFiles,
    refreshActiveFile,
    setActiveSource,
  } = useLogStore();
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('today');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [query, setQuery] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The workbench stays mounted (CSS-hidden) in other sections, so polling
  // must be gated on the active section to avoid needless backend calls.
  const activeSection = useAppStore((state) => state.activeSection);

  const parsedLines = useMemo(() => parseLogContent(content), [content]);

  const normalizedQuery = query.trim().toLowerCase();

  const searchFilteredLines = useMemo(() => {
    // Computed at filter time so relative date filters stay correct across midnight.
    const today = new Date();
    return parsedLines
      .map((line, index) => ({
        line,
        originalIndex: index,
      }))
      .filter(({ line }) => {
        if (!matchesDateFilter(line.date, dateFilter, today)) {
          return false;
        }
        if (normalizedQuery && !line.raw.toLowerCase().includes(normalizedQuery)) {
          return false;
        }
        return true;
      });
  }, [parsedLines, dateFilter, normalizedQuery]);

  const levelCounts = useMemo(() => {
    const counts: Partial<Record<LogLevel, number>> = {};
    for (const { line } of searchFilteredLines) {
      if (line.level && (LOG_LEVELS as readonly string[]).includes(line.level)) {
        const level = line.level as LogLevel;
        counts[level] = (counts[level] ?? 0) + 1;
      }
    }
    return counts;
  }, [searchFilteredLines]);

  const filteredLines = useMemo(() => {
    if (levelFilter === 'all') return searchFilteredLines;
    return searchFilteredLines.filter(({ line }) => line.level === levelFilter);
  }, [searchFilteredLines, levelFilter]);

  const virtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 20,
  });

  const updateIsAtBottom = useCallback((): void => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setIsAtBottom(distanceFromBottom <= 8);
  }, []);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    viewport.addEventListener('scroll', updateIsAtBottom, { passive: true });
    updateIsAtBottom();
    return () => viewport.removeEventListener('scroll', updateIsAtBottom);
  }, [updateIsAtBottom]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateIsAtBottom);
    return () => cancelAnimationFrame(frame);
  }, [filteredLines.length, updateIsAtBottom]);

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
    if (!activeFileName || activeSection !== 'workbench') return;
    const timer = setInterval(() => {
      refreshActiveFile();
    }, 2000);
    return () => clearInterval(timer);
  }, [activeFileName, activeSection, refreshActiveFile]);

  useEffect(() => {
    // Follow new lines only while the viewport stays pinned to the bottom;
    // any manual scroll moves away from the bottom and pauses following.
    if (isAtBottom && filteredLines.length > 0) {
      virtualizer.scrollToIndex(filteredLines.length - 1, { align: 'end' });
    }
  }, [filteredLines.length, isAtBottom, virtualizer]);

  const handleScrollToBottom = (): void => {
    if (filteredLines.length === 0) return;
    virtualizer.scrollToIndex(filteredLines.length - 1, {
      align: 'end',
      behavior: 'smooth',
    });
    setIsAtBottom(true);
  };

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

  const handleSourceChange = (value: LogSource | undefined): void => {
    if (!value) return;
    setActiveSource(value);
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <TooltipProvider>
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0">
            <h1 className="text-sm font-medium text-app-text">
              {t('workbench.logs.title')}
            </h1>
            {activeFileName && (
              <p className="truncate text-[11px] text-muted-foreground font-mono">
                {activeFileName}
              </p>
            )}
          </div>
        </div>
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-52">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.logs.searchPlaceholder')}
              aria-label={t('workbench.logs.searchPlaceholder')}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-app-text hover:bg-app-text/10"
                  aria-label={t('common.refresh')}
                  onClick={handleRefresh}
                />
              }
            >
              <RefreshCwIcon />
            </TooltipTrigger>
            <TooltipContent>{t('common.refresh')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-app-text hover:bg-app-text/10"
                  aria-label={t('workbench.logs.export')}
                  onClick={handleExport}
                  disabled={!content}
                />
              }
            >
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipContent>{t('workbench.logs.export')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.source')}
            </span>
            <ToggleGroup
              value={[activeSource]}
              onValueChange={(value) => {
                handleSourceChange(value[0] as LogSource | undefined);
              }}
              variant="tag"
              size="xs"
              spacing={1.5}
              aria-label={t('workbench.logs.source')}
            >
              <ToggleGroupItem value="frontend">
                {t('workbench.logs.frontend')}
              </ToggleGroupItem>
              <ToggleGroupItem value="backend">
                {t('workbench.logs.backend')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.date')}
            </span>
            <ToggleGroup
              value={[dateFilter]}
              onValueChange={(value) => {
                const nextValue = value[0] as DateFilterOption | undefined;
                if (nextValue) setDateFilter(nextValue);
              }}
              variant="tag"
              size="xs"
              spacing={1.5}
              aria-label={t('workbench.logs.date')}
            >
              {DATE_FILTER_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.key} value={option.key}>
                  {t(option.labelKey)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.level')}
            </span>
            <ToggleGroup
              value={[levelFilter]}
              onValueChange={(value) => {
                const nextValue = value[0] as LogLevel | 'all' | undefined;
                if (nextValue) setLevelFilter(nextValue);
              }}
              variant="tag"
              size="xs"
              spacing={1.5}
              aria-label={t('workbench.logs.level')}
            >
              <ToggleGroupItem value="all">
                {t('workbench.logs.all')}
              </ToggleGroupItem>
              {LOG_LEVELS.map((level) => (
                <ToggleGroupItem key={level} value={level}>
                  {level}
                  <span aria-hidden="true" className="ml-1 opacity-50">
                    {levelCounts[level] ?? 0}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <PanelLoadingState />
          </div>
        )}
        <ScrollArea
          className="min-h-0 flex-1 font-mono text-xs"
          viewportRef={scrollRef}
        >
          <div className={cn('p-1.5', filteredLines.length === 0 && !loading && 'h-full')}>
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
                        query={normalizedQuery}
                        onDoubleClick={() => copyLogContent(line.raw)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              !loading && (
                <div className="flex h-full min-h-40 items-center justify-center">
                  <EmptyState
                    icon={
                      content ? (
                        <SearchXIcon className="size-5" />
                      ) : (
                        <FileSearchIcon className="size-5" />
                      )
                    }
                    title={t(
                      content
                        ? 'workbench.logs.noMatches'
                        : 'workbench.logs.empty',
                    )}
                    description={
                      content
                        ? t('workbench.logs.noMatchesDescription')
                        : t('workbench.logs.emptyDescription', {
                            source: t(
                              activeSource === 'frontend'
                                ? 'workbench.logs.frontend'
                                : 'workbench.logs.backend',
                            ),
                          })
                    }
                  />
                </div>
              )
            )}
          </div>
        </ScrollArea>
        {!isAtBottom && filteredLines.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute bottom-3 right-4 z-10 size-8 rounded-full border border-app-border shadow-md"
                  aria-label={t('workbench.logs.scrollToBottom')}
                  onClick={handleScrollToBottom}
                />
              }
            >
              <ArrowDownToLineIcon />
            </TooltipTrigger>
            <TooltipContent>{t('workbench.logs.scrollToBottom')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
};
