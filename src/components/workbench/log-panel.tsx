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
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  FileSearchIcon,
  Layers3Icon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useLogStore } from '@/stores/logStore';
import type { LogSource } from '@/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { useToast } from '@/hooks/useToast';
import { invokeExportLogFile } from '@/lib/tauri';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn, formatBytes } from '@/lib/utils';
import { buildDiagnosticBundle } from '@/lib/diagnostic-bundle';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { isTauriRuntime } from '@/lib/tauri';

interface ParsedLogLine {
  raw: string;
  date?: string;
  time?: string;
  level?: string;
  target?: string;
  message?: string;
}

interface IndexedLogLine {
  line: ParsedLogLine;
  originalIndex: number;
}

interface ActivityBucket {
  total: number;
  errors: number;
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
  if (!match) return { raw: line };
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
  if (lines[lines.length - 1] === '') lines.pop();

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
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((todayMidnight.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function matchesDateFilter(
  lineDate: string | undefined,
  filter: DateFilterOption,
  today: Date,
): boolean {
  if (filter === 'all' || !lineDate) return true;
  const diff = getDaysDifference(lineDate, today);
  if (diff < 0 || diff > 29) return false;
  switch (filter) {
    case 'today': return diff === 0;
    case 'last3days': return diff <= 2;
    case 'last7days': return diff <= 6;
    case 'last30days': return diff <= 29;
    default: return true;
  }
}

function getLogTimestamp(line: ParsedLogLine): number | undefined {
  if (!line.date || !line.time) return undefined;
  const timestamp = new Date(`${line.date}T${line.time}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function buildActivityBuckets(entries: IndexedLogLine[], bucketCount = 36): ActivityBucket[] {
  const buckets = Array.from({ length: bucketCount }, () => ({ total: 0, errors: 0 }));
  if (entries.length === 0) return buckets;

  const timestamps = entries.map(({ line }) => getLogTimestamp(line));
  const validTimestamps = timestamps.filter(
    (timestamp): timestamp is number => timestamp !== undefined,
  );
  const start = validTimestamps.length > 0 ? Math.min(...validTimestamps) : 0;
  const end = validTimestamps.length > 0 ? Math.max(...validTimestamps) : 0;
  const hasTimeRange = end > start;

  entries.forEach(({ line }, index) => {
    const timestamp = timestamps[index];
    const ratio = hasTimeRange && timestamp !== undefined
      ? (timestamp - start) / (end - start)
      : index / Math.max(1, entries.length - 1);
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(ratio * bucketCount)),
    );
    buckets[bucketIndex].total += 1;
    if (line.level === 'ERROR') buckets[bucketIndex].errors += 1;
  });
  return buckets;
}

function getLevelClasses(level: string): string {
  switch (level) {
    case 'ERROR': return 'border-app-error/20 bg-app-error/10 text-app-error';
    case 'WARN': return 'border-app-warning/20 bg-app-warning/10 text-app-warning';
    case 'DEBUG': return 'border-app-primary/20 bg-app-primary/10 text-app-primary';
    default: return 'border-app-success/20 bg-app-success/10 text-app-success';
  }
}

function getLevelRailClass(level: string | undefined): string {
  switch (level) {
    case 'ERROR': return 'before:bg-app-error';
    case 'WARN': return 'before:bg-app-warning';
    case 'DEBUG': return 'before:bg-app-primary';
    default: return 'before:bg-transparent';
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
    if (matchIndex > cursor) nodes.push(text.slice(cursor, matchIndex));
    nodes.push(
      <mark key={key++} className="rounded-[2px] bg-app-warning/30 text-inherit">
        {text.slice(matchIndex, matchIndex + lowerQuery.length)}
      </mark>,
    );
    cursor = matchIndex + lowerQuery.length;
  }
  return nodes;
}

const LevelBadge: React.FC<{ level?: string }> = ({ level }) => (
  <Badge
    variant="outline"
    className={cn(
      'h-5 min-w-14 justify-center rounded-md px-1.5 font-mono text-[10px]',
      getLevelClasses(level ?? 'INFO'),
    )}
  >
    {level ?? 'RAW'}
  </Badge>
);

interface LogLineProps {
  line: ParsedLogLine;
  originalIndex: number;
  query: string;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
}

const LogLine: React.FC<LogLineProps> = ({
  line,
  originalIndex,
  query,
  selected,
  onSelect,
  onDoubleClick,
}) => {
  const timestamp = line.date && line.time
    ? `${line.date} ${line.time}`
    : `#${originalIndex + 1}`;
  const target = line.target?.split('::').pop();
  const message = line.message ?? line.raw;

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={cn(
        'relative grid w-full cursor-pointer grid-cols-[8.75rem_4.5rem_minmax(0,1fr)] items-start gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors before:absolute before:inset-y-0 before:left-0 before:w-0.5 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-app-primary/50 @min-[760px]:grid-cols-[8.75rem_4.5rem_8rem_minmax(0,1fr)]',
        selected && 'bg-muted/80',
        getLevelRailClass(line.level),
      )}
      aria-label={`${timestamp} ${line.level ?? ''} ${message}`}
    >
      <span className="truncate text-[11px] leading-5 text-muted-foreground">{timestamp}</span>
      <LevelBadge level={line.level} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="hidden truncate text-[11px] leading-5 text-muted-foreground @min-[760px]:block" />}
        >
          {target ? renderHighlightedText(target, query) : '—'}
        </TooltipTrigger>
        <TooltipContent>{line.target ?? `#${originalIndex + 1}`}</TooltipContent>
      </Tooltip>
      <span
        className="min-w-0 truncate whitespace-nowrap leading-5 text-foreground"
      >
        {renderHighlightedText(message, query)}
      </span>
    </button>
  );
};

const OverviewStat: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'default' | 'error' | 'warning';
}> = ({ icon, label, value, tone = 'default' }) => (
  <div className="flex min-w-24 items-center gap-2">
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-3.5',
        tone === 'error' && 'bg-app-error/10 text-app-error',
        tone === 'warning' && 'bg-app-warning/10 text-app-warning',
      )}
    >
      {icon}
    </span>
    <div className="flex min-w-0 flex-col">
      <span className="font-mono text-sm font-semibold leading-4 text-foreground">
        {value.toLocaleString()}
      </span>
      <span className="truncate text-[10px] leading-4 text-muted-foreground">{label}</span>
    </div>
  </div>
);

const ActivityHistogram: React.FC<{ buckets: ActivityBucket[]; label: string }> = ({
  buckets,
  label,
}) => {
  const { t } = useI18n();
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.total));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-app-primary/60" />
            {t('workbench.logs.activity.events')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-app-error" />
            {t('workbench.logs.activity.errors')}
          </span>
        </div>
      </div>
      <div
        className="flex h-10 items-end gap-px overflow-hidden rounded-sm bg-muted/40 px-1 pt-1"
        aria-label={label}
        role="img"
      >
        {buckets.map((bucket, index) => {
          const totalHeight = Math.max(
            bucket.total > 0 ? 8 : 2,
            Math.round((bucket.total / maxCount) * 36),
          );
          const errorRatio = bucket.total > 0 ? bucket.errors / bucket.total : 0;
          return (
            <span
              key={index}
              className="relative min-w-px flex-1 overflow-hidden rounded-t-[1px] bg-app-primary/50"
              style={{ height: `${totalHeight}px` }}
              aria-hidden="true"
            >
              {errorRatio > 0 && (
                <span
                  className="absolute inset-x-0 bottom-0 bg-app-error"
                  style={{ height: `${Math.max(2, errorRatio * 100)}%` }}
                />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const LogInspector: React.FC<{
  entry: IndexedLogLine;
  source: LogSource;
  onClose: () => void;
  onCopy: () => Promise<boolean>;
}> = ({ entry, source, onClose, onCopy }) => {
  const { t } = useI18n();
  const { line, originalIndex } = entry;
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timestamp = line.date && line.time ? `${line.date} ${line.time}` : '—';
  const fields = [
    [t('workbench.logs.inspector.timestamp'), timestamp],
    [t('workbench.logs.level'), line.level ?? 'RAW'],
    [t('workbench.logs.source'), t(source === 'frontend'
      ? 'workbench.logs.frontend'
      : 'workbench.logs.backend')],
    [t('workbench.logs.inspector.target'), line.target ?? '—'],
    [t('workbench.logs.inspector.line'), String(originalIndex + 1)],
  ];

  useEffect(() => {
    setCopied(false);
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, [originalIndex]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const handleCopy = async (): Promise<void> => {
    if (!await onCopy()) return;
    setCopied(true);
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col border-l border-border bg-card @max-[760px]:absolute @max-[760px]:inset-y-0 @max-[760px]:right-0 @max-[760px]:z-20 @max-[760px]:w-[min(22rem,92%)] @max-[760px]:shadow-xl">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">
            {t('workbench.logs.inspector.title')}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <div className="flex items-center justify-between gap-2">
            <LevelBadge level={line.level} />
            <Button
              variant="outline"
              size="xs"
              className="min-w-16"
              onClick={() => void handleCopy()}
              aria-live="polite"
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {t(copied
                ? 'workbench.logs.inspector.copied'
                : 'workbench.logs.inspector.copy')}
            </Button>
          </div>
          <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
            {fields.map(([fieldLabel, value]) => (
              <React.Fragment key={fieldLabel}>
                <dt className="text-muted-foreground">{fieldLabel}</dt>
                <dd className="break-all font-mono text-foreground">{value}</dd>
              </React.Fragment>
            ))}
          </dl>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.inspector.message')}
            </span>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2.5 font-mono text-[11px] leading-5 text-foreground">
              {line.message ?? line.raw}
            </pre>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.logs.inspector.raw')}
            </span>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2.5 font-mono text-[10px] leading-4 text-muted-foreground">
              {line.raw}
            </pre>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
};

export const LogPanel: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToast();
  const {
    files,
    activeFileName,
    activeSource,
    content,
    loading,
    error,
    loadFiles,
    refreshActiveFile,
    setActiveSource,
  } = useLogStore();
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('today');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [query, setQuery] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [selectedOriginalIndex, setSelectedOriginalIndex] = useState<number>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeSection = useAppStore((state) => state.activeSection);

  const parsedLines = useMemo(() => parseLogContent(content), [content]);
  const normalizedQuery = query.trim().toLowerCase();
  const searchFilteredLines = useMemo(() => {
    const today = new Date();
    return parsedLines
      .map((line, index) => ({ line, originalIndex: index }))
      .filter(({ line }) => {
        if (!matchesDateFilter(line.date, dateFilter, today)) return false;
        if (normalizedQuery && !line.raw.toLowerCase().includes(normalizedQuery)) return false;
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
  const uniqueTargetCount = useMemo(
    () => new Set(searchFilteredLines.map(({ line }) => line.target).filter(Boolean)).size,
    [searchFilteredLines],
  );
  const activityBuckets = useMemo(() => buildActivityBuckets(searchFilteredLines), [searchFilteredLines]);
  const selectedEntry = useMemo(
    () => filteredLines.find(({ originalIndex }) => originalIndex === selectedOriginalIndex),
    [filteredLines, selectedOriginalIndex],
  );
  const activeFile = files.find((file) => file.name === activeFileName);

  const virtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
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
    void loadFiles();
  }, [loadFiles]);

  const copyLogContent = useCallback(async (
    contentToCopy: string,
    showSuccess = true,
  ): Promise<boolean> => {
    if (!navigator.clipboard?.writeText) {
      showError(t('workbench.logs.copyFailed'));
      return false;
    }
    try {
      await navigator.clipboard.writeText(contentToCopy);
      if (showSuccess) success(t('workbench.logs.copied'));
      return true;
    } catch {
      showError(t('workbench.logs.copyFailed'));
      return false;
    }
  }, [success, showError, t]);

  useEffect(() => {
    if (!activeFileName || activeSection !== 'workbench') return;
    const timer = setInterval(() => { void refreshActiveFile(); }, 2000);
    return () => clearInterval(timer);
  }, [activeFileName, activeSection, refreshActiveFile]);

  useEffect(() => {
    if (isAtBottom && filteredLines.length > 0) {
      virtualizer.scrollToIndex(filteredLines.length - 1, { align: 'end' });
    }
  }, [filteredLines.length, isAtBottom, virtualizer]);

  const handleScrollToBottom = (): void => {
    if (filteredLines.length === 0) return;
    virtualizer.scrollToIndex(filteredLines.length - 1, { align: 'end', behavior: 'smooth' });
    setIsAtBottom(true);
  };
  const handleRefresh = (): void => {
    void loadFiles().then(() => {
      if (activeFileName) void refreshActiveFile();
    });
  };
  const handleExport = useCallback(async (): Promise<void> => {
    if (!content) return;
    const defaultName = activeFileName ?? 'termbridge-logs.txt';
    try {
      const savedPath = await invokeExportLogFile(defaultName, content);
      if (savedPath) success(t('workbench.logs.exported', { path: savedPath }));
    } catch {
      showError(t('workbench.logs.exportFailed'));
    }
  }, [content, activeFileName, success, showError, t]);
  const handleDiagnosticBundle = useCallback(async (): Promise<void> => {
    try {
      const version = isTauriRuntime()
        ? await import('@tauri-apps/api/app').then(({ getVersion }) => getVersion())
        : 'development';
      const transferOperations = useTransferStore.getState().operations;
      const providers = useAiSettingsStore.getState().providers;
      const generatedAt = new Date();
      const bundle = buildDiagnosticBundle({
        version,
        platform: navigator.userAgent,
        locale: useAppStore.getState().locale,
        featureState: {
          terminalSessions: useTerminalStore.getState().sessions.length,
          sftpTabs: useSftpStore.getState().connections.length,
          activeTransfers: transferOperations.filter((operation) => (
            operation.status === 'pending'
            || operation.status === 'running'
            || operation.status === 'cancelling'
          )).length,
          aiConfigured: providers.some((provider) => (
            provider.baseUrl.trim().length > 0 && provider.model.trim().length > 0
          )),
        },
        recentFailures: transferOperations
          .filter((operation) => operation.status === 'failed')
          .slice(0, 20)
          .map((operation) => ({
            operationId: operation.operationId,
            kind: operation.kind,
            category: operation.errorCategory ?? 'unknown',
          })),
        selectedLog: content
          ? { name: activeFileName ?? 'termbridge.log', source: activeSource, content }
          : undefined,
      }, generatedAt.toISOString());
      const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
      const savedPath = await invokeExportLogFile(
        `termbridge-diagnostic-${stamp}.json`,
        bundle,
      );
      if (savedPath) success(t('workbench.logs.diagnosticExported', { path: savedPath }));
    } catch {
      showError(t('workbench.logs.diagnosticFailed'));
    }
  }, [activeFileName, activeSource, content, showError, success, t]);
  const handleSourceChange = (value: LogSource | undefined): void => {
    if (!value) return;
    setSelectedOriginalIndex(undefined);
    setActiveSource(value);
  };
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <TooltipProvider>
      <div className="@container flex h-full min-w-0 flex-col bg-background">
        <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-card px-4 pb-3 pt-3">
          <div className="flex items-center justify-between gap-3 @max-[640px]:flex-col @max-[640px]:items-stretch">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold tracking-tight text-foreground">
                  {t('workbench.logs.title')}
                </h1>
                <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', isAtBottom ? 'bg-app-success' : 'bg-app-warning')} />
                  {t(isAtBottom ? 'workbench.logs.live' : 'workbench.logs.followPaused')}
                </Badge>
              </div>
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate font-mono">
                  {activeFileName ?? t('workbench.logs.noActiveFile')}
                </span>
                {activeFile && <span className="shrink-0">· {formatBytes(activeFile.size)}</span>}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 @max-[640px]:justify-between">
              <ToggleGroup
                value={[activeSource]}
                onValueChange={(value) => handleSourceChange(value[0] as LogSource | undefined)}
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={t('workbench.logs.source')}
              >
                <ToggleGroupItem value="frontend">{t('workbench.logs.frontend')}</ToggleGroupItem>
                <ToggleGroupItem value="backend">{t('workbench.logs.backend')}</ToggleGroupItem>
              </ToggleGroup>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8"
                      aria-label={t('common.refresh')}
                      onClick={handleRefresh}
                    />
                  }
                >
                  <RefreshCwIcon />
                </TooltipTrigger>
                <TooltipContent>{t('common.refresh')}</TooltipContent>
              </Tooltip>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={!content}>
                <DownloadIcon data-icon="inline-start" />
                {t('workbench.logs.export')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleDiagnosticBundle}>
                <BugIcon data-icon="inline-start" />
                {t('workbench.logs.diagnostic')}
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-5 rounded-lg border border-border bg-background px-3 py-2 @max-[600px]:flex-col @max-[600px]:items-stretch">
            <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-2 @min-[960px]:grid-cols-4">
              <OverviewStat icon={<Layers3Icon />} label={t('workbench.logs.stats.results')} value={filteredLines.length} />
              <OverviewStat icon={<CircleAlertIcon />} label={t('workbench.logs.stats.errors')} value={levelCounts.ERROR ?? 0} tone="error" />
              <OverviewStat icon={<CircleAlertIcon />} label={t('workbench.logs.stats.warnings')} value={levelCounts.WARN ?? 0} tone="warning" />
              <OverviewStat icon={<BugIcon />} label={t('workbench.logs.stats.targets')} value={uniqueTargetCount} />
            </div>
            <div className="h-12 w-px shrink-0 bg-border @max-[600px]:h-px @max-[600px]:w-full" />
            <ActivityHistogram buckets={activityBuckets} label={t('workbench.logs.activity')} />
          </div>
        </header>

        <section className="flex shrink-0 flex-col gap-2 border-b border-border bg-card px-4 py-2.5">
          <InputGroup className="h-9 bg-background">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.logs.searchPlaceholder')}
              aria-label={t('workbench.logs.searchPlaceholder')}
              className="font-mono text-xs"
            />
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" onClick={() => setQuery('')} aria-label={t('workbench.logs.clearSearch')}>
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('workbench.logs.date')}</span>
                <ToggleGroup
                  value={[dateFilter]}
                  onValueChange={(value) => {
                    const nextValue = value[0] as DateFilterOption | undefined;
                    if (nextValue) setDateFilter(nextValue);
                  }}
                  variant="tag"
                  size="xs"
                  spacing={1}
                  className="max-w-full flex-wrap"
                  aria-label={t('workbench.logs.date')}
                >
                  {DATE_FILTER_OPTIONS.map((option) => (
                    <ToggleGroupItem key={option.key} value={option.key}>{t(option.labelKey)}</ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="h-4 w-px bg-border @max-[760px]:hidden" />
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('workbench.logs.level')}</span>
                <ToggleGroup
                  value={[levelFilter]}
                  onValueChange={(value) => {
                    const nextValue = value[0] as LogLevel | 'all' | undefined;
                    if (nextValue) setLevelFilter(nextValue);
                  }}
                  variant="tag"
                  size="xs"
                  spacing={1}
                  className="max-w-full flex-wrap"
                  aria-label={t('workbench.logs.level')}
                >
                  <ToggleGroupItem value="all">{t('workbench.logs.all')}</ToggleGroupItem>
                  {LOG_LEVELS.map((level) => (
                    <ToggleGroupItem key={level} value={level}>
                      {level}<span aria-hidden="true" className="ml-1 opacity-50">{levelCounts[level] ?? 0}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{t('workbench.logs.resultCount', { count: filteredLines.length })}</span>
            </div>
          </div>
        </section>

        {error && (
          <Alert variant="destructive" className="mx-4 mt-3 shrink-0">
            <CircleAlertIcon />
            <AlertTitle>{t('workbench.logs.loadFailed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="grid h-8 shrink-0 grid-cols-[8.75rem_4.5rem_minmax(0,1fr)] items-center gap-2 border-b border-border bg-muted/35 px-3 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground @min-[760px]:grid-cols-[8.75rem_4.5rem_8rem_minmax(0,1fr)]">
              <span>{t('workbench.logs.columns.time')}</span>
              <span>{t('workbench.logs.level')}</span>
              <span className="hidden @min-[760px]:block">{t('workbench.logs.columns.target')}</span>
              <span>{t('workbench.logs.columns.message')}</span>
            </div>
            {loading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
                <PanelLoadingState />
              </div>
            )}
            <ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
              <div className={cn(filteredLines.length === 0 && !loading && 'h-full')}>
                {filteredLines.length > 0 ? (
                  <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                    {virtualItems.map((virtualItem) => {
                      const entry = filteredLines[virtualItem.index];
                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          ref={virtualizer.measureElement}
                          className="border-b border-border/50"
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          <LogLine
                            line={entry.line}
                            originalIndex={entry.originalIndex}
                            query={normalizedQuery}
                            selected={entry.originalIndex === selectedOriginalIndex}
                            onSelect={() => setSelectedOriginalIndex(entry.originalIndex)}
                            onDoubleClick={() => void copyLogContent(entry.line.raw)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  !loading && (
                    <div className="flex h-full min-h-48 items-center justify-center">
                      <EmptyState
                        icon={content ? <SearchXIcon className="size-5" /> : <FileSearchIcon className="size-5" />}
                        title={t(content ? 'workbench.logs.noMatches' : 'workbench.logs.empty')}
                        description={content
                          ? t('workbench.logs.noMatchesDescription')
                          : t('workbench.logs.emptyDescription', {
                              source: t(activeSource === 'frontend'
                                ? 'workbench.logs.frontend'
                                : 'workbench.logs.backend'),
                            })}
                      />
                    </div>
                  )
                )}
              </div>
            </ScrollArea>
          </div>

          {selectedEntry && (
            <LogInspector
              entry={selectedEntry}
              source={activeSource}
              onClose={() => setSelectedOriginalIndex(undefined)}
              onCopy={() => copyLogContent(selectedEntry.line.raw, false)}
            />
          )}

          {!isAtBottom && filteredLines.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute bottom-3 right-4 size-8 rounded-full border border-border shadow-md"
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
