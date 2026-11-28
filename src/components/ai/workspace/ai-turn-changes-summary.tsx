import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FileCodeIcon,
  FileCogIcon,
  FileTextIcon,
  HistoryIcon,
  LoaderCircleIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNode, AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { cn } from '@/lib/utils';
import { AiHeaderIconButton } from './ai-header-icon-button';
import {
  AiToolExpandedContent,
  AiTrashRecoveryNotice,
  applyToolEditToText,
  buildTurnFileDiffPreview,
  extractToolFileChanges,
  type ToolFileChangeEntry,
} from './ai-tool-presentation';

export const AiTurnFileBaselinesContext = createContext<ReadonlyMap<string, ReadonlyMap<string, string>> | null>(null);
export const AiTurnRollbackContext = createContext<((paths: readonly string[]) => void) | undefined>(undefined);

export interface TurnChangedFileEntry extends ToolFileChangeEntry {
  readonly tools: readonly ToolFileChangeEntry['tool'][];
  readonly baseText: string | null;
}

export interface TurnFileChangesSummary {
  readonly files: readonly TurnChangedFileEntry[];
  readonly totalAdded: number | null;
  readonly totalRemoved: number | null;
}

const MAX_TRACKED_BASELINE_BYTES = 200_000;
export const TURN_CHANGES_AUTO_EXPAND_MAX_FILES = 6;
export const TURN_CHANGES_AUTO_EXPAND_MAX_LINES = 400;
const TURN_CHANGES_JUMP_MENU_MIN_FILES = 8;
const REVIEW_FILE_INITIAL_ROWS = 200;
const REVIEW_BATCH_READY_PER_FRAME = 3;
const ESTIMATED_DIFF_LINE_HEIGHT_PX = 18;
const MIN_PLACEHOLDER_HEIGHT_PX = 48;
const MAX_ESTIMATED_PLACEHOLDER_HEIGHT_PX = 420;

export function shouldAutoExpandAllFiles(summary: TurnFileChangesSummary): boolean {
  if (summary.files.length > TURN_CHANGES_AUTO_EXPAND_MAX_FILES) return false;
  if (summary.totalAdded !== null && summary.totalRemoved !== null) {
    return summary.totalAdded + summary.totalRemoved <= TURN_CHANGES_AUTO_EXPAND_MAX_LINES;
  }
  return true;
}

function estimateReviewBodyHeight(file: TurnChangedFileEntry): number {
  if (file.kind === 'deleted') return 56;
  const changedLines = (file.added ?? 0) + (file.removed ?? 0);
  if (changedLines <= 0) return 80;
  const visibleRows = Math.min(changedLines + 6, REVIEW_FILE_INITIAL_ROWS);
  return Math.max(
    MIN_PLACEHOLDER_HEIGHT_PX,
    Math.min(MAX_ESTIMATED_PLACEHOLDER_HEIGHT_PX, visibleRows * ESTIMATED_DIFF_LINE_HEIGHT_PX + 12),
  );
}

function normalizePathKey(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectToolPathKeys(tool: AiConversationNodeOf<'tool'>): readonly string[] {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) {
      keys.add(value);
      keys.add(normalizePathKey(value));
    }
  };
  if (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)) {
    const input = tool.input as Record<string, unknown>;
    add(input.path);
    add(input.file_path);
    add(input.filePath);
  }
  if (tool.output && typeof tool.output === 'object' && !Array.isArray(tool.output)) {
    const output = tool.output as Record<string, unknown>;
    add(output.path);
    add(output.file_path);
    add(output.filePath);
    if (Array.isArray(output.files)) {
      for (const item of output.files) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          add((item as Record<string, unknown>).path);
        }
      }
    }
  }
  return [...keys];
}

function lookupBaseline(map: ReadonlyMap<string, string>, path: string, aliases: readonly string[] = []): string | null {
  const normalized = normalizePathKey(path);
  const direct = map.get(path) ?? map.get(normalized);
  if (direct !== undefined) return direct;
  for (const alias of aliases) {
    const found = map.get(alias);
    if (found !== undefined) return found;
  }
  let suffixMatch: string | null = null;
  for (const [key, content] of map.entries()) {
    const normKey = normalizePathKey(key);
    if (normKey.endsWith(`/${normalized}`) || normalized.endsWith(`/${normKey}`)) {
      if (suffixMatch !== null && suffixMatch !== content) return null;
      suffixMatch = content;
    }
  }
  return suffixMatch;
}

function storeBaseline(map: Map<string, string>, paths: readonly string[], content: string): void {
  if (content.length > MAX_TRACKED_BASELINE_BYTES) return;
  for (const key of paths) {
    map.set(key, content);
  }
}

function extractFullReadFileContent(
  tool: AiConversationNodeOf<'tool'>,
): { readonly paths: readonly string[]; readonly content: string } | null {
  if (tool.state !== 'succeeded') return null;
  if (tool.name !== 'read_file' && tool.nativeName !== 'read_file') return null;
  if (!tool.output || typeof tool.output !== 'object' || Array.isArray(tool.output)) return null;
  const output = tool.output as Record<string, unknown>;
  const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
    ? tool.input as Record<string, unknown>
    : null;
  const paths = collectToolPathKeys(tool);
  if (paths.length === 0) return null;
  if (typeof output.content !== 'string') return null;
  if (output.truncated === true) return null;
  if (output.encoding === 'base64' || output.encoding === 'metadataOnly') return null;
  const offset = typeof output.offset === 'number'
    ? output.offset
    : typeof input?.offset === 'number'
      ? input.offset
      : 0;
  if (offset !== 0) return null;
  return { paths, content: output.content };
}

function extractFullWriteFileContent(
  tool: AiConversationNodeOf<'tool'>,
): { readonly paths: readonly string[]; readonly content: string } | null {
  if (tool.state !== 'succeeded') return null;
  if (tool.name !== 'write_file' && tool.nativeName !== 'write_file') return null;
  if (!tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) return null;
  const content = (tool.input as Record<string, unknown>).content;
  if (typeof content !== 'string') return null;
  const paths = collectToolPathKeys(tool);
  if (paths.length === 0) return null;
  return { paths, content };
}

const EMPTY_BASELINE_MAP: ReadonlyMap<string, string> = new Map();
const turnBaselineStepCache = new WeakMap<
  ReadonlyMap<string, string>,
  WeakMap<AiConversationNodeOf<'turnProcess'>, ReadonlyMap<string, string>>
>();

function advanceTurnBaselineMap(
  priorMap: ReadonlyMap<string, string>,
  node: AiConversationNodeOf<'turnProcess'>,
): ReadonlyMap<string, string> {
  const byNode = turnBaselineStepCache.get(priorMap);
  const cached = byNode?.get(node);
  if (cached) return cached;

  let nextMap: Map<string, string> | null = null;
  const ensureMutable = (): Map<string, string> => {
    if (!nextMap) nextMap = new Map(priorMap);
    return nextMap;
  };
  for (const child of node.children) {
    if (child.kind !== 'tool' || child.state !== 'succeeded') continue;
    const readSnapshot = extractFullReadFileContent(child);
    if (readSnapshot) {
      storeBaseline(ensureMutable(), readSnapshot.paths, readSnapshot.content);
      continue;
    }
    const writeSnapshot = extractFullWriteFileContent(child);
    if (writeSnapshot) {
      storeBaseline(ensureMutable(), writeSnapshot.paths, writeSnapshot.content);
      continue;
    }
    if (child.name === 'trash_file' || child.nativeName === 'trash_file') {
      const targetMap = ensureMutable();
      for (const key of collectToolPathKeys(child)) targetMap.delete(key);
      continue;
    }
    const changes = extractToolFileChanges(child);
    if (changes.length === 0) continue;
    const aliases = collectToolPathKeys(child);
    for (const entry of changes) {
      if (entry.kind === 'deleted') {
        const targetMap = ensureMutable();
        targetMap.delete(entry.path);
        targetMap.delete(normalizePathKey(entry.path));
        continue;
      }
      const current = lookupBaseline(nextMap ?? priorMap, entry.path, aliases);
      if (current === null) continue;
      const patched = applyToolEditToText(current, entry.path, child);
      if (patched !== null) {
        storeBaseline(ensureMutable(), [entry.path, normalizePathKey(entry.path), ...aliases], patched);
      } else {
        const targetMap = ensureMutable();
        for (const key of [entry.path, normalizePathKey(entry.path), ...aliases]) {
          targetMap.delete(key);
        }
      }
    }
  }

  const result: ReadonlyMap<string, string> = nextMap ?? priorMap;
  let nextByNode = byNode;
  if (!nextByNode) {
    nextByNode = new WeakMap();
    turnBaselineStepCache.set(priorMap, nextByNode);
  }
  nextByNode.set(node, result);
  return result;
}

export function buildConversationTurnBaselines(
  nodes: readonly AiConversationNode[],
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const byTurnKey = new Map<string, ReadonlyMap<string, string>>();
  let currentMap: ReadonlyMap<string, string> = EMPTY_BASELINE_MAP;
  for (const node of nodes) {
    if (node.kind !== 'turnProcess') continue;
    byTurnKey.set(node.key, currentMap);
    currentMap = advanceTurnBaselineMap(currentMap, node);
  }
  return byTurnKey;
}

export function summarizeTurnFileChanges(
  process: AiConversationNodeOf<'turnProcess'> | undefined,
  priorBaselines?: ReadonlyMap<string, string>,
): TurnFileChangesSummary | null {
  if (!process || process.status === 'running' || !process.hasEndBoundary) return null;
  const merged = new Map<string, TurnChangedFileEntry>();
  const baselineByPath = new Map<string, string>(priorBaselines ?? []);
  for (const child of process.children) {
    if (child.kind !== 'tool') continue;
    const readSnapshot = extractFullReadFileContent(child);
    if (readSnapshot) {
      const alreadyModified = readSnapshot.paths.some((key) => merged.has(key));
      if (!alreadyModified) {
        storeBaseline(baselineByPath, readSnapshot.paths, readSnapshot.content);
      }
      continue;
    }
    const toolAliases = collectToolPathKeys(child);
    for (const entry of extractToolFileChanges(child)) {
      const existing = merged.get(entry.path);
      if (!existing) {
        merged.set(entry.path, {
          ...entry,
          tools: [entry.tool],
          baseText: entry.kind === 'deleted' ? null : lookupBaseline(baselineByPath, entry.path, toolAliases),
        });
        continue;
      }
      const exact = existing.added !== null && existing.removed !== null
        && entry.added !== null && entry.removed !== null
        && entry.kind !== 'deleted' && existing.kind !== 'deleted';
      const tools = entry.kind === 'deleted'
        ? [entry.tool]
        : existing.tools[existing.tools.length - 1] === entry.tool
          ? existing.tools
          : [...existing.tools, entry.tool];
      merged.set(entry.path, {
        path: entry.path,
        added: exact ? (existing.added ?? 0) + (entry.added ?? 0) : null,
        removed: exact ? (existing.removed ?? 0) + (entry.removed ?? 0) : null,
        kind: entry.kind,
        tool: entry.tool,
        tools,
        baseText: entry.kind === 'deleted' ? null : existing.baseText,
      });
    }
  }
  if (merged.size === 0) return null;
  const files = [...merged.values()];
  let totalAdded: number | null = 0;
  let totalRemoved: number | null = 0;
  let hasAnyCounts = false;
  for (const file of files) {
    if (file.added === null || file.removed === null) {
      if (file.kind !== 'deleted') {
        totalAdded = null;
        totalRemoved = null;
        break;
      }
      continue;
    }
    hasAnyCounts = true;
    if (totalAdded !== null) totalAdded += file.added;
    if (totalRemoved !== null) totalRemoved += file.removed;
  }
  return {
    files,
    totalAdded: hasAnyCounts ? totalAdded : null,
    totalRemoved: hasAnyCounts ? totalRemoved : null,
  };
}

function extractSavedLineCount(output: unknown): number | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (typeof record.lineCount === 'number' && Number.isFinite(record.lineCount)) {
    return Math.max(0, Math.trunc(record.lineCount));
  }
  const snapshot = record.snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const snapshotLines = (snapshot as Record<string, unknown>).lineCount;
    if (typeof snapshotLines === 'number' && Number.isFinite(snapshotLines)) {
      return Math.max(0, Math.trunc(snapshotLines));
    }
  }
  return null;
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'kt',
  'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'css', 'scss', 'less',
  'html', 'vue', 'svelte', 'sql', 'rb', 'php', 'swift',
]);

const CONFIG_EXTENSIONS = new Set([
  'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'xml', 'lock',
]);

function splitFilePath(path: string): { basename: string; directory: string | null } {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) return { basename: path, directory: null };
  const basename = path.slice(lastSlash + 1) || path;
  const directory = lastSlash === 0 ? '/' : path.slice(0, lastSlash);
  return { basename, directory };
}

function FileChangeIcon({ path, kind }: { readonly path: string; readonly kind: ToolFileChangeEntry['kind'] }) {
  if (kind === 'deleted') {
    return <Trash2Icon className="ai-turn-changes-file-icon size-3.5 shrink-0" aria-hidden="true" />;
  }
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (CODE_EXTENSIONS.has(ext)) {
    return <FileCodeIcon className="ai-turn-changes-file-icon size-3.5 shrink-0" aria-hidden="true" />;
  }
  if (CONFIG_EXTENSIONS.has(ext)) {
    return <FileCogIcon className="ai-turn-changes-file-icon size-3.5 shrink-0" aria-hidden="true" />;
  }
  return <FileTextIcon className="ai-turn-changes-file-icon size-3.5 shrink-0" aria-hidden="true" />;
}

const TurnChangedFileItem = memo(function TurnChangedFileItem({
  file,
  onSelect,
}: {
  readonly file: TurnChangedFileEntry;
  readonly onSelect: (file: TurnChangedFileEntry) => void;
}) {
  const { t } = useI18n();
  const { basename, directory } = useMemo(() => splitFilePath(file.path), [file.path]);

  return (
    <li className="ai-turn-changes-item min-w-0">
      <button
        type="button"
        className="ai-turn-changes-file flex h-8 w-full min-w-0 items-center justify-between gap-3 px-3.5 text-left"
        title={file.path}
        aria-label={t('ai.workspace.turnChanges.openDiff', { path: file.path })}
        onClick={() => onSelect(file)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('flex items-center gap-1', directory ? 'max-w-[60%] shrink-0' : 'min-w-0')}>
            <FileChangeIcon path={file.path} kind={file.kind} />
            <span className="ai-turn-changes-basename min-w-0 truncate">{basename}</span>
          </span>
          {directory && (
            <span className="ai-turn-changes-dir min-w-0 truncate">{directory}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {file.kind === 'deleted' ? (
            <span className="ai-turn-changes-deleted shrink-0 text-xs">{t('ai.workspace.turnChanges.deleted')}</span>
          ) : file.added !== null && file.removed !== null ? (
            <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
              <span data-diff-count="added">+{file.added}</span>
              <span data-diff-count="removed">-{file.removed}</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

const TurnReviewFileBody = memo(function TurnReviewFileBody({
  file,
  placeholderHeight,
  onMeasureHeight,
}: {
  readonly file: TurnChangedFileEntry;
  readonly placeholderHeight: number;
  readonly onMeasureHeight: (
    path: string,
    height: number,
    previousPlaceholderHeight: number,
    anchorScroll: boolean,
  ) => void;
}) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);

  const fileDiff = useMemo(() => {
    if (file.kind === 'deleted') return null;
    return buildTurnFileDiffPreview(file.path, file.tools, file.baseText);
  }, [file]);

  const savedLineCount = useMemo(
    () => (file.kind === 'deleted' || fileDiff ? null : extractSavedLineCount(file.tool.output)),
    [file.kind, file.tool.output, fileDiff],
  );

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    if (height > 0) {
      onMeasureHeight(file.path, height, placeholderHeight, true);
    }
    return () => {
      const finalHeight = el.getBoundingClientRect().height;
      if (finalHeight > 0) {
        onMeasureHeight(file.path, finalHeight, placeholderHeight, false);
      }
    };
  }, [file.path, fileDiff, onMeasureHeight, placeholderHeight]);

  return (
    <div
      ref={bodyRef}
      className="ai-turn-changes-review-body min-w-0 border-b border-app-border/40"
      data-ai-turn-changes-file-body=""
    >
      {file.kind === 'deleted' ? (
        <div className="px-4 py-3">
          <AiTrashRecoveryNotice />
        </div>
      ) : fileDiff ? (
        <AiToolExpandedContent
          node={file.tool}
          compact
          showCopyActions={false}
          showInput={false}
          hideHeader
          foldContext
          scrollable={false}
          maxInitialRows={REVIEW_FILE_INITIAL_ROWS}
          diffModel={fileDiff}
        />
      ) : (
        <div className="ai-turn-changes-saved-summary px-4 py-3 text-sm">
          {savedLineCount !== null
            ? t('ai.workspace.turnChanges.savedLines', { count: savedLineCount })
            : t('ai.workspace.turnChanges.savedNoDiff')}
        </div>
      )}
    </div>
  );
});

const TurnReviewFileSection = memo(function TurnReviewFileSection({
  file,
  expanded,
  renderContent,
  preparing,
  placeholderHeight,
  registerSection,
  onTogglePath,
  onMeasureBodyHeight,
}: {
  readonly file: TurnChangedFileEntry;
  readonly expanded: boolean;
  readonly renderContent: boolean;
  readonly preparing: boolean;
  readonly placeholderHeight: number;
  readonly registerSection: (path: string, element: HTMLElement | null) => void;
  readonly onTogglePath: (path: string, open: boolean) => void;
  readonly onMeasureBodyHeight: (
    path: string,
    height: number,
    previousPlaceholderHeight: number,
    anchorScroll: boolean,
  ) => void;
}) {
  const { t } = useI18n();
  const { basename, directory } = useMemo(() => splitFilePath(file.path), [file.path]);
  const handleSectionRef = useCallback((node: HTMLElement | null) => {
    registerSection(file.path, node);
  }, [file.path, registerSection]);
  const handleOpenChange = useCallback((open: boolean) => {
    onTogglePath(file.path, open);
  }, [file.path, onTogglePath]);

  return (
    <section
      ref={handleSectionRef}
      className="ai-turn-changes-review-section min-w-0"
      data-ai-turn-changes-review-file={file.path}
    >
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <div className="ai-turn-changes-review-row sticky top-0 z-[12] flex h-9 min-w-0 items-center border-b border-app-border/40">
          <CollapsibleTrigger
            render={(
              <button
                type="button"
                className="ai-turn-changes-review-trigger flex h-full min-w-0 flex-1 items-center justify-between gap-2 px-3.5 text-left"
                title={file.path}
                aria-label={t('ai.workspace.turnChanges.openDiff', { path: file.path })}
                aria-expanded={expanded}
              />
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className={cn('flex items-center gap-1', directory ? 'max-w-[60%] shrink-0' : 'min-w-0')}>
                <FileChangeIcon path={file.path} kind={file.kind} />
                <span className="ai-turn-changes-basename min-w-0 truncate">{basename}</span>
              </span>
              {directory && (
                <span className="ai-turn-changes-dir min-w-0 truncate">{directory}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {file.kind === 'deleted' ? (
                <span className="ai-turn-changes-deleted shrink-0 text-xs">{t('ai.workspace.turnChanges.deleted')}</span>
              ) : file.added !== null && file.removed !== null ? (
                <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
                  <span data-diff-count="added">+{file.added}</span>
                  <span data-diff-count="removed">-{file.removed}</span>
                </span>
              ) : null}
              {preparing ? (
                <LoaderCircleIcon
                  className="ai-turn-changes-chevron size-3.5 shrink-0 animate-spin"
                  aria-label={t('ai.workspace.turnChanges.loadingDiff')}
                  data-ai-turn-changes-loading=""
                />
              ) : (
                <ChevronRightIcon
                  className={cn('ai-turn-changes-chevron size-3.5 shrink-0', expanded && 'rotate-90')}
                  aria-hidden="true"
                />
              )}
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {expanded && (
            renderContent ? (
              <TurnReviewFileBody
                file={file}
                placeholderHeight={placeholderHeight}
                onMeasureHeight={onMeasureBodyHeight}
              />
            ) : (
              <div
                className="ai-turn-changes-review-placeholder flex min-w-0 items-center gap-1 border-b border-app-border/40 px-4 py-3"
                style={{ minHeight: `${placeholderHeight}px` }}
                data-ai-turn-changes-placeholder=""
              >
                {preparing && (
                  <>
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                    <span>{t('ai.workspace.turnChanges.loadingDiff')}</span>
                  </>
                )}
              </div>
            )
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
});

function TurnReviewFileJumpMenu({
  files,
  onJumpToFile,
}: {
  readonly files: readonly TurnChangedFileEntry[];
  readonly onJumpToFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files.filter((file) => file.path.toLowerCase().includes(trimmed));
  }, [files, query]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
    }
  };

  useEffect(() => {
    if (!open) return;
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => inputRef.current?.focus())
      : null;
    if (frame === null) {
      inputRef.current?.focus();
    }
    return () => {
      if (frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
    };
  }, [open]);

  const handleSelect = (path: string) => {
    setOpen(false);
    setQuery('');
    onJumpToFile(path);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              render={(
                <AiHeaderIconButton
                  type="button"
                  aria-label={t('ai.workspace.turnChanges.jumpToFile')}
                  data-testid="turn-changes-jump-trigger"
                />
              )}
            />
          )}
        >
          <SearchIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{t('ai.workspace.turnChanges.jumpToFile')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 gap-2 p-2">
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && filteredFiles.length > 0) {
              event.preventDefault();
              handleSelect(filteredFiles[0].path);
            }
          }}
          placeholder={t('ai.workspace.turnChanges.filterPlaceholder')}
          aria-label={t('ai.workspace.turnChanges.filterPlaceholder')}
          className="h-8 text-xs"
        />
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t('ai.workspace.turnChanges.noMatchingFiles')}
          </div>
        ) : (
          <ScrollArea
            className="flex max-h-64 min-h-0 flex-col overflow-hidden"
            viewportRender={<div className="max-h-64 min-h-0 flex-1" />}
          >
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {filteredFiles.map((file) => {
                const { basename, directory } = splitFilePath(file.path);
                return (
                  <li key={file.path} className="min-w-0">
                    <button
                      type="button"
                      className="ai-turn-changes-jump-item flex h-8 w-full min-w-0 items-center justify-between gap-2 px-2 text-left text-xs"
                      title={file.path}
                      onClick={() => handleSelect(file.path)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className={cn('flex items-center gap-1', directory ? 'max-w-[65%] shrink-0' : 'min-w-0')}>
                          <FileChangeIcon path={file.path} kind={file.kind} />
                          <span className="ai-turn-changes-basename min-w-0 truncate">{basename}</span>
                        </span>
                        {directory && (
                          <span className="ai-turn-changes-dir min-w-0 truncate">{directory}</span>
                        )}
                      </span>
                      {file.kind === 'deleted' ? (
                        <span className="ai-turn-changes-deleted shrink-0 text-[11px]">{t('ai.workspace.turnChanges.deleted')}</span>
                      ) : file.added !== null && file.removed !== null ? (
                        <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
                          <span data-diff-count="added">+{file.added}</span>
                          <span data-diff-count="removed">-{file.removed}</span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TurnChangedFilesOverlay({
  summary,
  title,
  initialFilePath,
  portalContainer,
  onOpenRollback,
  onClose,
}: {
  readonly summary: TurnFileChangesSummary;
  readonly title: string;
  readonly initialFilePath: string;
  readonly portalContainer: HTMLElement | null;
  readonly onOpenRollback?: (paths: readonly string[]) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const autoExpandAll = useMemo(() => shouldAutoExpandAllFiles(summary), [summary]);
  const lazyVirtualize = !autoExpandAll;
  const hasIntersectionObserver = typeof IntersectionObserver !== 'undefined';

  const sectionElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => (
    autoExpandAll
      ? new Set(summary.files.map((file) => file.path))
      : new Set([initialFilePath])
  ));
  const [readyPaths, setReadyPaths] = useState<ReadonlySet<string>>(() => (
    autoExpandAll
      ? new Set(summary.files.map((file) => file.path))
      : new Set([initialFilePath])
  ));
  const [nearViewportPaths, setNearViewportPaths] = useState<ReadonlySet<string>>(() => (
    autoExpandAll || !hasIntersectionObserver
      ? new Set(summary.files.map((file) => file.path))
      : new Set([initialFilePath])
  ));
  const [scrollTarget, setScrollTarget] = useState<{ readonly path: string; readonly nonce: number } | null>(() => (
    summary.files.length > 1 ? { path: initialFilePath, nonce: 0 } : null
  ));

  const registerSection = useCallback((path: string, element: HTMLElement | null) => {
    const prev = sectionElementsRef.current.get(path);
    if (prev && prev !== element) {
      observerRef.current?.unobserve(prev);
    }
    if (element) {
      sectionElementsRef.current.set(path, element);
      observerRef.current?.observe(element);
    } else {
      sectionElementsRef.current.delete(path);
    }
  }, []);

  useEffect(() => {
    if (!lazyVirtualize || !hasIntersectionObserver) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setNearViewportPaths((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const path = (entry.target as HTMLElement).dataset.aiTurnChangesReviewFile;
            if (!path) continue;
            if (entry.isIntersecting) {
              if (!next.has(path)) {
                next.add(path);
                changed = true;
              }
            } else if (next.has(path)) {
              next.delete(path);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: viewport, rootMargin: '600px 0px' },
    );
    observerRef.current = observer;
    for (const element of sectionElementsRef.current.values()) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) {
        observerRef.current = null;
      }
    };
  }, [hasIntersectionObserver, lazyVirtualize]);

  // Incrementally admit expanded near-viewport files into readyPaths across frames
  // so clicking "Expand all" on 30+ files never freezes the main thread.
  useEffect(() => {
    const waiting: string[] = [];
    for (const file of summary.files) {
      if (!expandedPaths.has(file.path)) continue;
      if (readyPaths.has(file.path)) continue;
      if (lazyVirtualize && hasIntersectionObserver && !nearViewportPaths.has(file.path)) continue;
      waiting.push(file.path);
    }
    if (waiting.length === 0) return;

    const batch = waiting.slice(0, REVIEW_BATCH_READY_PER_FRAME);
    const admit = () => {
      setReadyPaths((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const path of batch) {
          if (!next.has(path)) {
            next.add(path);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(admit);
      return () => cancelAnimationFrame(handle);
    }
    const timer = globalThis.setTimeout(admit, 0);
    return () => clearTimeout(timer);
  }, [expandedPaths, hasIntersectionObserver, lazyVirtualize, nearViewportPaths, readyPaths, summary.files]);

  const handleTogglePath = useCallback((path: string, nextOpen: boolean) => {
    setExpandedPaths((prev) => {
      const has = prev.has(path);
      if (nextOpen === has) return prev;
      const next = new Set(prev);
      if (nextOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (nextOpen) {
      setReadyPaths((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      setNearViewportPaths((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    }
  }, []);

  const handleMeasureBodyHeight = useCallback((
    path: string,
    measuredHeight: number,
    previousPlaceholderHeight: number,
    anchorScroll: boolean,
  ) => {
    const previousHeight = measuredHeightsRef.current.get(path) ?? previousPlaceholderHeight;
    measuredHeightsRef.current.set(path, measuredHeight);
    if (!anchorScroll) return;
    const viewport = viewportRef.current;
    const section = sectionElementsRef.current.get(path);
    if (!viewport || !section) return;
    const delta = measuredHeight - previousHeight;
    // Anchor scroll position when a section above the viewport changes height during lazy mount.
    if (Math.abs(delta) > 1 && section.offsetTop + 36 < viewport.scrollTop) {
      viewport.scrollTop += delta;
    }
  }, []);

  useLayoutEffect(() => {
    if (!scrollTarget) return;
    const section = sectionElementsRef.current.get(scrollTarget.path);
    const viewport = viewportRef.current;
    if (!section) return;
    if (viewport && typeof section.offsetTop === 'number' && section.offsetTop > 0) {
      viewport.scrollTop = section.offsetTop;
    } else if (typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start' });
    }
  }, [scrollTarget]);

  const handleJumpToFile = useCallback((path: string) => {
    handleTogglePath(path, true);
    setScrollTarget((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    const section = sectionElementsRef.current.get(path);
    section?.querySelector<HTMLButtonElement>('.ai-turn-changes-review-trigger')?.focus();
  }, [handleTogglePath]);

  const allExpanded = useMemo(
    () => summary.files.length > 0 && summary.files.every((file) => expandedPaths.has(file.path)),
    [expandedPaths, summary.files],
  );

  const handleToggleAll = useCallback(() => {
    if (allExpanded) {
      setExpandedPaths(new Set());
    } else {
      setExpandedPaths(new Set(summary.files.map((file) => file.path)));
    }
  }, [allExpanded, summary.files]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        const targetEl = event.target instanceof Element ? event.target : null;
        const topDialog = targetEl?.closest('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]');
        if (topDialog && topDialog !== overlay && !overlay.contains(topDialog)) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const targetEl = event.target instanceof Element ? event.target : null;
      const topDialog = targetEl?.closest('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]');
      if (topDialog && topDialog !== overlay && !overlay.contains(topDialog)) return;
      const focusables = overlay.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!active || !overlay.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, false);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, false);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);

  const target = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  const scopedToPanel = portalContainer !== null;

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal={!scopedToPanel}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (event.defaultPrevented) return;
          const targetEl = event.target instanceof Element ? event.target : null;
          const topDialog = targetEl?.closest('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]');
          if (topDialog && topDialog !== overlayRef.current && !overlayRef.current?.contains(topDialog)) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        'ai-turn-changes-dialog flex min-h-0 min-w-0 flex-col overflow-hidden outline-none',
        scopedToPanel ? 'absolute inset-0 z-[15]' : 'fixed inset-0 z-50',
      )}
    >
      <div className="ai-turn-changes-dialog-header flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-app-border/50 pl-2 pr-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={(
                <AiHeaderIconButton
                  ref={closeButtonRef}
                  type="button"
                  aria-label={t('common.back')}
                  onClick={onClose}
                />
              )}
            >
              <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{t('common.back')}</TooltipContent>
          </Tooltip>
          <h2 id={titleId} className="ai-turn-changes-title m-0 min-w-0 truncate text-sm">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {summary.totalAdded !== null && summary.totalRemoved !== null && (
            <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
              <span data-diff-count="added">+{summary.totalAdded}</span>
              <span data-diff-count="removed">-{summary.totalRemoved}</span>
            </span>
          )}
          {summary.files.length >= TURN_CHANGES_JUMP_MENU_MIN_FILES && (
            <TurnReviewFileJumpMenu files={summary.files} onJumpToFile={handleJumpToFile} />
          )}
          {summary.files.length > 1 && (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <AiHeaderIconButton
                    type="button"
                    aria-label={t(allExpanded ? 'ai.workspace.turnChanges.collapseAll' : 'ai.workspace.turnChanges.expandAll')}
                    data-testid="turn-changes-toggle-all"
                    onClick={handleToggleAll}
                  />
                )}
              >
                {allExpanded
                  ? <ChevronsDownUpIcon aria-hidden="true" />
                  : <ChevronsUpDownIcon aria-hidden="true" />}
              </TooltipTrigger>
              <TooltipContent>
                {t(allExpanded ? 'ai.workspace.turnChanges.collapseAll' : 'ai.workspace.turnChanges.expandAll')}
              </TooltipContent>
            </Tooltip>
          )}
          {onOpenRollback && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 gap-1 px-2 text-xs"
              aria-label={t('ai.workspace.turnChanges.rollbackAria')}
              onClick={() => {
                const paths = [initialFilePath, ...summary.files.map((file) => file.path)];
                onClose();
                onOpenRollback(paths);
              }}
            >
              <HistoryIcon data-icon="inline-start" aria-hidden="true" />
              <span>{t('ai.workspace.turnChanges.rollback')}</span>
            </Button>
          )}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        <div className="flex min-w-0 flex-col">
          {summary.files.map((file) => {
            const expanded = expandedPaths.has(file.path);
            const inViewport = !lazyVirtualize || !hasIntersectionObserver || nearViewportPaths.has(file.path);
            const ready = readyPaths.has(file.path);
            const renderContent = expanded && inViewport && ready;
            const preparing = expanded && inViewport && !ready;
            const placeholderHeight = measuredHeightsRef.current.get(file.path) ?? estimateReviewBodyHeight(file);
            return (
              <TurnReviewFileSection
                key={file.path}
                file={file}
                expanded={expanded}
                renderContent={renderContent}
                preparing={preparing}
                placeholderHeight={placeholderHeight}
                registerSection={registerSection}
                onTogglePath={handleTogglePath}
                onMeasureBodyHeight={handleMeasureBodyHeight}
              />
            );
          })}
        </div>
      </ScrollArea>
    </div>,
    target,
  );
}

export function AiTurnChangesSummary({
  process,
}: {
  readonly process?: AiConversationNodeOf<'turnProcess'>;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const baselinesByTurn = useContext(AiTurnFileBaselinesContext);
  const onOpenRollback = useContext(AiTurnRollbackContext);
  const priorBaselines = process ? baselinesByTurn?.get(process.key) : undefined;
  const summary = useMemo(() => summarizeTurnFileChanges(process, priorBaselines), [process, priorBaselines]);
  if (!summary) return null;

  const title = summary.files.length === 1
    ? t('ai.workspace.turnChanges.summarySingle')
    : t('ai.workspace.turnChanges.summary', { count: summary.files.length });

  const handleSelectFile = useCallback((file: TurnChangedFileEntry) => {
    setPortalContainer(rootRef.current?.closest<HTMLElement>('.ai-panel-shell') ?? null);
    setSelectedFilePath(file.path);
  }, []);

  const handleCloseOverlay = useCallback(() => {
    setSelectedFilePath(null);
  }, []);

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          ref={rootRef}
          className="ai-turn-changes mb-2 ml-1.5 min-w-0 max-w-full overflow-hidden"
          data-expanded={open || undefined}
          data-ai-turn-changes=""
        >
          <div className="ai-turn-changes-header flex min-w-0 items-center transition-colors">
            <CollapsibleTrigger
              render={(
                <Button
                  type="button"
                  variant="plain"
                  size="sm"
                  className="ai-turn-changes-trigger flex h-9 min-w-0 flex-1 items-center justify-start gap-2 px-3.5 text-left"
                  aria-expanded={open}
                />
              )}
            >
              <span className="ai-turn-changes-title min-w-0 truncate">{title}</span>
              {summary.totalAdded !== null && summary.totalRemoved !== null && (
                <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums" data-ai-turn-changes-totals="">
                  <span data-diff-count="added">+{summary.totalAdded}</span>
                  <span data-diff-count="removed">-{summary.totalRemoved}</span>
                </span>
              )}
              <ChevronDownIcon className={cn('ai-turn-changes-chevron size-3.5 shrink-0', open && 'rotate-180')} aria-hidden="true" />
            </CollapsibleTrigger>
            {onOpenRollback && (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="mr-1.5 h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      data-testid="turn-changes-rollback-trigger"
                      aria-label={t('ai.workspace.turnChanges.rollbackAria')}
                      onClick={() => onOpenRollback(summary.files.map((file) => file.path))}
                    />
                  )}
                >
                  <HistoryIcon data-icon="inline-start" aria-hidden="true" />
                  <span>{t('ai.workspace.turnChanges.rollback')}</span>
                </TooltipTrigger>
                <TooltipContent>{t('ai.workspace.turnChanges.rollbackAria')}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <CollapsibleContent>
            <ul className="ai-turn-changes-list m-0 flex list-none flex-col p-0">
              {summary.files.map((file) => (
                <TurnChangedFileItem key={file.path} file={file} onSelect={handleSelectFile} />
              ))}
            </ul>
          </CollapsibleContent>
        </div>
      </Collapsible>
      {selectedFilePath && (
        <TurnChangedFilesOverlay
          summary={summary}
          title={title}
          initialFilePath={selectedFilePath}
          portalContainer={portalContainer}
          onOpenRollback={onOpenRollback}
          onClose={handleCloseOverlay}
        />
      )}
    </>
  );
}
