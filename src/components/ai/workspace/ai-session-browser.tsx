import { useEffect, useMemo, useState } from 'react';
import { ArchiveIcon, BotIcon, BrainCircuitIcon, PencilIcon, SquarePenIcon } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { AiRouteHeader } from './ai-route-header';

type SessionFilter = 'all' | 'ask' | 'agent' | 'running' | 'archived';

function matches(summary: AiSessionSummary, filter: SessionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ask' || filter === 'agent') return summary.kind === filter;
  if (filter === 'archived') return summary.archived;
  return summary.status === 'running' || summary.status === 'waiting';
}

export function AiSessionBrowser({
  sessions,
  loading,
  error,
  archivingId,
  renamingId = null,
  renameError = null,
  onBack,
  onNew,
  onOpen,
  onArchive,
  onRename,
}: {
  readonly sessions: readonly AiSessionSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly archivingId: string | null;
  readonly renamingId?: string | null;
  readonly renameError?: string | null;
  readonly onBack: () => void;
  readonly onNew: () => void;
  readonly onOpen: (summary: AiSessionSummary) => void;
  readonly onArchive: (summary: AiSessionSummary) => void;
  readonly onRename?: (summary: AiSessionSummary, title: string) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [archiveTarget, setArchiveTarget] = useState<AiSessionSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<AiSessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [submittedTitle, setSubmittedTitle] = useState<string | null>(null);
  const visible = useMemo(() => sessions.filter((summary) => matches(summary, filter)), [filter, sessions]);

  useEffect(() => {
    if (!renameTarget || !submittedTitle || renamingId !== null) return;
    const committed = sessions.find((summary) => (
      summary.kind === renameTarget.kind && summary.id === renameTarget.id
    ));
    if (committed?.title === submittedTitle) {
      setRenameTarget(null);
      setSubmittedTitle(null);
    } else if (committed && committed.revision !== renameTarget.revision) {
      setRenameTarget(committed);
    }
  }, [renameTarget, renamingId, sessions, submittedTitle]);

  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col" data-slot="ai-session-browser">
      <AiRouteHeader
        title={t('ai.workspace.sessions.title')}
        description={t('ai.workspace.sessions.description')}
        onBack={onBack}
        actions={(
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon" className="size-8" onClick={onNew} aria-label={t('ai.newConversation')} />
              )}
            >
              <SquarePenIcon />
            </TooltipTrigger>
            <TooltipContent>{t('ai.newConversation')}</TooltipContent>
          </Tooltip>
        )}
      />
      <div className="shrink-0 overflow-x-auto border-b border-border p-2">
        <ToggleGroup
          value={[filter]}
          onValueChange={(value) => setFilter((value[0] as SessionFilter | undefined) ?? 'all')}
          aria-label={t('ai.workspace.sessions.filter')}
          size="sm"
          variant="outline"
          className="w-max"
        >
          {(['all', 'ask', 'agent', 'running', 'archived'] as const).map((value) => (
            <ToggleGroupItem key={value} value={value} aria-label={t(`ai.workspace.sessions.filter.${value}`)}>
              {t(`ai.workspace.sessions.filter.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1" aria-label={t('ai.workspace.sessions.title')}>
        <ScrollAreaContent className="flex min-w-0 flex-col gap-1 p-2">
          {loading && (
            <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner /> {t('common.loading')}
            </div>
          )}
          {error && <p className="break-words p-2 text-sm text-destructive" role="alert">{error}</p>}
          {!loading && !error && visible.length === 0 && (
            <PanelEmptyState
              icon={<ArchiveIcon />}
              title={t('ai.workspace.sessions.emptyTitle')}
              description={t('ai.workspace.sessions.emptyDescription')}
            />
          )}
          {visible.map((summary) => {
            const active = summary.status === 'running' || summary.status === 'waiting';
            const KindIcon = summary.kind === 'agent' ? BrainCircuitIcon : BotIcon;
            return (
              <div key={`${summary.kind}:${summary.id}`} className="flex min-w-0 items-center gap-1 rounded-md hover:bg-muted/50">
                <button
                  type="button"
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpen(summary)}
                >
                  <KindIcon className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{summary.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {new Date(summary.updatedAt).toLocaleString()} · {summary.scopeKey}
                    </span>
                  </span>
                  <Badge variant={active ? 'secondary' : summary.archived ? 'outline' : 'default'}>{summary.status}</Badge>
                </button>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        disabled={
                          summary.kind !== 'agent'
                          || summary.archived
                          || ['completed', 'failed', 'cancelled'].includes(summary.status)
                          || renamingId !== null
                        }
                        onClick={() => {
                          setRenameTarget(summary);
                          setRenameValue(summary.title);
                          setSubmittedTitle(null);
                        }}
                        aria-label={t('ai.workspace.sessions.rename')}
                      />
                    )}
                  >
                    {renamingId === summary.id ? <Spinner /> : <PencilIcon />}
                  </TooltipTrigger>
                  <TooltipContent>
                    {summary.kind !== 'agent'
                      ? t('ai.workspace.sessions.renameAgentOnly')
                      : summary.archived
                        ? t('ai.workspace.sessions.renameArchivedDisabled')
                        : ['completed', 'failed', 'cancelled'].includes(summary.status)
                          ? t('ai.workspace.sessions.renameTerminalDisabled')
                          : t('ai.workspace.sessions.rename')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        disabled={active || archivingId === summary.id}
                        onClick={() => setArchiveTarget(summary)}
                        aria-label={t('ai.workspace.sessions.archiveLabel', { title: summary.title })}
                      />
                    )}
                  >
                    {archivingId === summary.id ? <Spinner /> : <ArchiveIcon />}
                  </TooltipTrigger>
                  <TooltipContent>{active ? t('ai.workspace.sessions.archiveRunningDisabled') : t('ai.workspace.sessions.archive')}</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </ScrollAreaContent>
      </ScrollArea>

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.workspace.sessions.archiveConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.workspace.sessions.archiveConfirmDescription', { title: archiveTarget?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!archiveTarget || archivingId !== null}
              onClick={() => {
                if (archiveTarget) onArchive(archiveTarget);
                setArchiveTarget(null);
              }}
            >
              {t('ai.workspace.sessions.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && renamingId === null) {
            setRenameTarget(null);
            setSubmittedTitle(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ai.workspace.sessions.renameTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ai.workspace.sessions.renameDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FieldGroup>
            <Field data-invalid={!renameValue.trim() || renameError !== null}>
              <FieldLabel htmlFor="ai-session-rename-input">
                {t('ai.workspace.sessions.renameLabel')}
              </FieldLabel>
              <Input
                id="ai-session-rename-input"
                value={renameValue}
                maxLength={120}
                disabled={renamingId !== null}
                aria-invalid={!renameValue.trim() || renameError !== null}
                autoFocus
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  setSubmittedTitle(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && renameTarget && renameValue.trim() && renamingId === null) {
                    event.preventDefault();
                    const title = renameValue.trim();
                    setSubmittedTitle(title);
                    onRename?.(renameTarget, title);
                  }
                }}
              />
              <FieldError>{renameError}</FieldError>
            </Field>
          </FieldGroup>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renamingId !== null}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!renameTarget || !renameValue.trim() || renamingId !== null}
              onClick={() => {
                if (!renameTarget) return;
                const title = renameValue.trim();
                setSubmittedTitle(title);
                onRename?.(renameTarget, title);
              }}
            >
              {renamingId !== null && <Spinner data-icon="inline-start" />}
              {t('common.save')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
