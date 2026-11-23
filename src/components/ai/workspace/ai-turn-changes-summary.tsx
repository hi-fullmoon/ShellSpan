import { useMemo, useState } from 'react';
import { ChevronDownIcon, FilePenLineIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CopyButton } from '@/components/ui/copy-button';
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

function TurnChangedFileItem({ file }: { readonly file: ToolFileChangeEntry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const fileDiff = useMemo(() => {
    if (file.kind === 'deleted') return null;
    const preview = toolDiffPreview(file.tool);
    if (!preview) return null;
    const matchingHunks = preview.hunks.filter((hunk) => hunk.path === file.path);
    if (matchingHunks.length === 0) return preview;
    return { ...preview, hunks: matchingHunks };
  }, [file.kind, file.path, file.tool]);

  const savedLineCount = useMemo(
    () => (file.kind === 'deleted' || fileDiff ? null : extractSavedLineCount(file.tool.output)),
    [file.kind, file.tool.output, fileDiff],
  );

  return (
    <li className="ai-turn-changes-item min-w-0">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          render={(
            <button
              type="button"
              className="ai-turn-changes-file flex h-8 w-full min-w-0 items-center justify-between gap-2 px-3 text-left"
              data-expanded={expanded || undefined}
              title={file.path}
              aria-label={t('ai.workspace.turnChanges.openDiff', { path: file.path })}
              aria-expanded={expanded}
            />
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {file.kind === 'deleted'
              ? <Trash2Icon className="size-3.5 shrink-0" aria-hidden="true" />
              : <FilePenLineIcon className="size-3.5 shrink-0" aria-hidden="true" />}
            <span className="ai-turn-changes-path min-w-0 truncate">{file.path}</span>
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
            <ChevronDownIcon className={cn('ai-turn-changes-chevron size-3.5 shrink-0', expanded && 'rotate-180')} aria-hidden="true" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-turn-changes-file-body min-w-0" data-ai-turn-changes-file-body="">
            {file.kind === 'deleted' ? (
              <div className="flex flex-col gap-2 px-3 py-2">
                <AiTrashRecoveryNotice />
                <div className="flex justify-end">
                  <CopyButton
                    text={file.path}
                    label={t('ai.workspace.turnChanges.copyPath')}
                    variant="ghost"
                    size="xs"
                  />
                </div>
              </div>
            ) : fileDiff ? (
              <AiToolExpandedContent
                node={file.tool}
                compact
                showInput={false}
                hideHeader
                diffModel={fileDiff}
              />
            ) : (
              <div className="ai-turn-changes-saved-summary flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 break-words text-xs">
                  {savedLineCount !== null
                    ? t('ai.workspace.turnChanges.savedLines', { count: savedLineCount })
                    : t('ai.workspace.turnChanges.savedNoDiff')}
                </span>
                <CopyButton
                  text={file.path}
                  label={t('ai.workspace.turnChanges.copyPath')}
                  variant="ghost"
                  size="xs"
                  className="shrink-0"
                />
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function AiTurnChangesSummary({
  process,
}: {
  readonly process?: AiConversationNodeOf<'turnProcess'>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeTurnFileChanges(process), [process]);
  if (!summary) return null;

  const title = summary.files.length === 1
    ? t('ai.workspace.turnChanges.summarySingle')
    : t('ai.workspace.turnChanges.summary', { count: summary.files.length });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
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
              className="ai-turn-changes-trigger flex h-8 w-full min-w-0 items-center justify-between gap-2 px-3 text-left"
              aria-expanded={open}
            />
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <FilePenLineIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="ai-turn-changes-title min-w-0 truncate">{title}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {summary.totalAdded !== null && summary.totalRemoved !== null && (
              <span className="ai-turn-changes-counts inline-flex items-center gap-1 tabular-nums" data-ai-turn-changes-totals="">
                <span data-diff-count="added">+{summary.totalAdded}</span>
                <span data-diff-count="removed">-{summary.totalRemoved}</span>
              </span>
            )}
            <ChevronDownIcon className={cn('ai-turn-changes-chevron size-3.5 shrink-0', open && 'rotate-180')} aria-hidden="true" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="ai-turn-changes-list m-0 flex list-none flex-col p-0">
            {summary.files.map((file) => (
              <TurnChangedFileItem key={file.path} file={file} />
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
