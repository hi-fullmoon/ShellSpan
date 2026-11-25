import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, FileCodeIcon, FileCogIcon, FileTextIcon, HistoryIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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

export function buildConversationTurnBaselines(
  nodes: readonly AiConversationNode[],
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const byTurnKey = new Map<string, ReadonlyMap<string, string>>();
  const knownByPath = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== 'turnProcess') continue;
    byTurnKey.set(node.key, new Map(knownByPath));
    for (const child of node.children) {
      if (child.kind !== 'tool' || child.state !== 'succeeded') continue;
      const readSnapshot = extractFullReadFileContent(child);
      if (readSnapshot) {
        storeBaseline(knownByPath, readSnapshot.paths, readSnapshot.content);
        continue;
      }
      const writeSnapshot = extractFullWriteFileContent(child);
      if (writeSnapshot) {
        storeBaseline(knownByPath, writeSnapshot.paths, writeSnapshot.content);
        continue;
      }
      if (child.name === 'trash_file' || child.nativeName === 'trash_file') {
        for (const key of collectToolPathKeys(child)) knownByPath.delete(key);
        continue;
      }
      const changes = extractToolFileChanges(child);
      if (changes.length === 0) continue;
      const aliases = collectToolPathKeys(child);
      for (const entry of changes) {
        if (entry.kind === 'deleted') {
          knownByPath.delete(entry.path);
          knownByPath.delete(normalizePathKey(entry.path));
          continue;
        }
        const current = lookupBaseline(knownByPath, entry.path, aliases);
        if (current === null) continue;
        const patched = applyToolEditToText(current, entry.path, child);
        if (patched !== null) {
          storeBaseline(knownByPath, [entry.path, normalizePathKey(entry.path), ...aliases], patched);
        } else {
          for (const key of [entry.path, normalizePathKey(entry.path), ...aliases]) {
            knownByPath.delete(key);
          }
        }
      }
    }
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

function TurnChangedFileItem({
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
}

function TurnReviewFileSection({
  file,
  expanded,
  autoScroll,
  onExpandedChange,
}: {
  readonly file: TurnChangedFileEntry;
  readonly expanded: boolean;
  readonly autoScroll: boolean;
  readonly onExpandedChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement>(null);
  const { basename, directory } = useMemo(() => splitFilePath(file.path), [file.path]);

  const fileDiff = useMemo(() => {
    if (file.kind === 'deleted') return null;
    return buildTurnFileDiffPreview(file.path, file.tools, file.baseText);
  }, [file]);

  const savedLineCount = useMemo(
    () => (file.kind === 'deleted' || fileDiff ? null : extractSavedLineCount(file.tool.output)),
    [file.kind, file.tool.output, fileDiff],
  );

  useEffect(() => {
    if (autoScroll && sectionRef.current && typeof sectionRef.current.scrollIntoView === 'function') {
      sectionRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [autoScroll]);

  return (
    <section
      ref={sectionRef}
      className="ai-turn-changes-review-section min-w-0"
      data-ai-turn-changes-review-file={file.path}
    >
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
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
              <ChevronRightIcon
                className={cn('ai-turn-changes-chevron size-3.5 shrink-0', expanded && 'rotate-90')}
                aria-hidden="true"
              />
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="ai-turn-changes-review-body min-w-0 border-b border-app-border/40" data-ai-turn-changes-file-body="">
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
        </CollapsibleContent>
      </Collapsible>
    </section>
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
  readonly initialFilePath: string | null;
  readonly portalContainer: HTMLElement | null;
  readonly onOpenRollback?: (paths: readonly string[]) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const filesRef = useRef(summary.files);
  filesRef.current = summary.files;
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!initialFilePath) return;
    setExpandedPaths(new Set(filesRef.current.map((file) => file.path)));
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [initialFilePath]);

  if (!initialFilePath) return null;

  const target = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  const scopedToPanel = portalContainer !== null;

  return createPortal(
    <div
      role="dialog"
      aria-modal={!scopedToPanel}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
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
        <div className="flex shrink-0 items-center gap-2">
          {summary.totalAdded !== null && summary.totalRemoved !== null && (
            <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
              <span data-diff-count="added">+{summary.totalAdded}</span>
              <span data-diff-count="removed">-{summary.totalRemoved}</span>
            </span>
          )}
          {onOpenRollback && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 gap-1 px-2 text-xs"
              aria-label={t('ai.workspace.turnChanges.rollbackAria')}
              onClick={() => {
                const paths = initialFilePath
                  ? [initialFilePath, ...summary.files.map((file) => file.path)]
                  : summary.files.map((file) => file.path);
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-w-0 flex-col">
          {summary.files.map((file) => (
            <TurnReviewFileSection
              key={file.path}
              file={file}
              expanded={expandedPaths.has(file.path)}
              autoScroll={summary.files.length > 1 && file.path === initialFilePath}
              onExpandedChange={(nextOpen) => {
                setExpandedPaths((prev) => {
                  const next = new Set(prev);
                  if (nextOpen) next.add(file.path);
                  else next.delete(file.path);
                  return next;
                });
              }}
            />
          ))}
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

  const handleSelectFile = (file: TurnChangedFileEntry) => {
    setPortalContainer(rootRef.current?.closest<HTMLElement>('.ai-panel-shell') ?? null);
    setSelectedFilePath(file.path);
  };

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          ref={rootRef}
          className="ai-turn-changes mb-2 ml-1.5 min-w-0 max-w-full overflow-hidden"
          data-expanded={open || undefined}
          data-ai-turn-changes=""
        >
          <div className="flex min-w-0 items-center">
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
      <TurnChangedFilesOverlay
        summary={summary}
        title={title}
        initialFilePath={selectedFilePath}
        portalContainer={portalContainer}
        onOpenRollback={onOpenRollback}
        onClose={() => setSelectedFilePath(null)}
      />
    </>
  );
}
