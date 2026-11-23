import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, FileCodeIcon, FileCogIcon, FileTextIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CopyButton } from '@/components/ui/copy-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { cn } from '@/lib/utils';
import {
  AiToolExpandedContent,
  AiTrashRecoveryNotice,
  extractToolFileChanges,
  toolDiffPreview,
  type ToolFileChangeEntry,
} from './ai-tool-presentation';

export interface TurnFileChangesSummary {
  readonly files: readonly ToolFileChangeEntry[];
  readonly totalAdded: number | null;
  readonly totalRemoved: number | null;
}

export function summarizeTurnFileChanges(
  process: AiConversationNodeOf<'turnProcess'> | undefined,
): TurnFileChangesSummary | null {
  if (!process || process.status === 'running' || !process.hasEndBoundary) return null;
  const merged = new Map<string, ToolFileChangeEntry>();
  for (const child of process.children) {
    if (child.kind !== 'tool') continue;
    for (const entry of extractToolFileChanges(child)) {
      const existing = merged.get(entry.path);
      if (!existing) {
        merged.set(entry.path, entry);
        continue;
      }
      const exact = existing.added !== null && existing.removed !== null
        && entry.added !== null && entry.removed !== null
        && entry.kind !== 'deleted' && existing.kind !== 'deleted';
      merged.set(entry.path, {
        path: entry.path,
        added: exact ? (existing.added ?? 0) + (entry.added ?? 0) : null,
        removed: exact ? (existing.removed ?? 0) + (entry.removed ?? 0) : null,
        kind: entry.kind,
        tool: entry.tool,
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
  readonly file: ToolFileChangeEntry;
  readonly onSelect: (file: ToolFileChangeEntry) => void;
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
  readonly file: ToolFileChangeEntry;
  readonly expanded: boolean;
  readonly autoScroll: boolean;
  readonly onExpandedChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLElement>(null);
  const { basename, directory } = useMemo(() => splitFilePath(file.path), [file.path]);

  const fileDiff = useMemo(() => {
    if (file.kind === 'deleted') return null;
    const preview = toolDiffPreview(file.tool);
    if (!preview) return null;
    const matchingHunks = preview.hunks.filter((hunk) => hunk.path === file.path);
    if (matchingHunks.length === 0) return preview;
    return { ...preview, hunks: matchingHunks };
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
        <div className="ai-turn-changes-review-row sticky top-0 z-[12] flex h-9 min-w-0 items-center border-b border-app-border/40 pr-2.5">
          <CollapsibleTrigger
            render={(
              <button
                type="button"
                className="ai-turn-changes-review-trigger flex h-full min-w-0 flex-1 items-center justify-between gap-2 pl-3.5 pr-1 text-left"
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
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center gap-1.5">
            <CopyButton
              text={file.path}
              label={t('ai.workspace.turnChanges.copyPath')}
              iconOnly
              size="icon-xs"
              className="ai-turn-changes-review-copy"
            />
            {file.kind === 'deleted' ? (
              <span className="ai-turn-changes-deleted shrink-0 text-xs">{t('ai.workspace.turnChanges.deleted')}</span>
            ) : file.added !== null && file.removed !== null ? (
              <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
                <span data-diff-count="added">+{file.added}</span>
                <span data-diff-count="removed">-{file.removed}</span>
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => onExpandedChange(!expanded)}
            >
              <ChevronRightIcon
                className={cn('ai-turn-changes-chevron size-3.5 shrink-0', expanded && 'rotate-90')}
                aria-hidden="true"
              />
            </Button>
          </div>
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
                showInput={false}
                hideHeader
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
  onClose,
}: {
  readonly summary: TurnFileChangesSummary;
  readonly title: string;
  readonly initialFilePath: string | null;
  readonly portalContainer: HTMLElement | null;
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
      <div className="ai-turn-changes-dialog-header flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-app-border/50 px-[var(--ai-shell-clearance)]">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          </Button>
          <h2 id={titleId} className="ai-turn-changes-title m-0 min-w-0 truncate text-[13px]">{title}</h2>
        </div>
        {summary.totalAdded !== null && summary.totalRemoved !== null && (
          <span className="ai-turn-changes-counts inline-flex shrink-0 items-center gap-1 tabular-nums">
            <span data-diff-count="added">+{summary.totalAdded}</span>
            <span data-diff-count="removed">-{summary.totalRemoved}</span>
          </span>
        )}
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
  const summary = useMemo(() => summarizeTurnFileChanges(process), [process]);
  if (!summary) return null;

  const title = summary.files.length === 1
    ? t('ai.workspace.turnChanges.summarySingle')
    : t('ai.workspace.turnChanges.summary', { count: summary.files.length });

  const handleSelectFile = (file: ToolFileChangeEntry) => {
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
          <CollapsibleTrigger
            render={(
              <Button
                type="button"
                variant="plain"
                size="sm"
                className="ai-turn-changes-trigger flex h-9 w-full min-w-0 items-center justify-start gap-2 px-3.5 text-left"
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
        onClose={() => setSelectedFilePath(null)}
      />
    </>
  );
}
