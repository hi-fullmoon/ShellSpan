import { useEffect, useMemo, useState } from 'react';
import {
  ArchiveIcon,
  ChevronDownIcon,
  EllipsisIcon,
  FilterIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SquarePenIcon,
} from 'lucide-react';

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
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PanelEmptyState, Spinner } from '@/components/ui/empty-state';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import { AiRouteHeader } from './ai-route-header';
import { AiHeaderIconButton } from './ai-header-icon-button';

type SessionFilter = 'all' | 'running' | 'archived';

const FILTERS = ['all', 'running', 'archived'] as const;

function matches(summary: AiSessionSummary, filter: SessionFilter): boolean {
  if (filter === 'archived') return summary.archived;
  if (filter === 'all') return !summary.archived;
  return !summary.archived && (summary.status === 'running' || summary.status === 'waiting');
}

function sessionStatusLabel(status: AiSessionStatus, t: (key: LocaleKey) => string): string {
  if (status === 'idle') return t('agent.session.status.idle');
  if (status === 'waiting') return t('agent.session.status.waiting');
  return t(`agent.outcome.${status}`);
}

function relativeTimeLabel(timestamp: string, locale: string): string {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return timestamp;
  const deltaSeconds = Math.round((then - Date.now()) / 1_000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteSeconds < 60
    ? [deltaSeconds, 'second']
    : absoluteSeconds < 3_600
      ? [Math.round(deltaSeconds / 60), 'minute']
      : absoluteSeconds < 86_400
        ? [Math.round(deltaSeconds / 3_600), 'hour']
        : [Math.round(deltaSeconds / 86_400), 'day'];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }).format(value, unit);
}

function SessionBrowserLoading({ label }: { readonly label: string }): React.ReactNode {
  return (
    <div className="ai-session-browser-loading" role="status" aria-label={label}>
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="ai-session-browser-skeleton" key={index}>
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

function NewSessionButton({
  canStartAgent,
  unavailableReason,
  onNew,
}: {
  readonly canStartAgent: boolean;
  readonly unavailableReason?: string | null;
  readonly onNew: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <AiHeaderIconButton
            disabled={!canStartAgent}
            onClick={onNew}
            aria-label={t('ai.newConversation')}
          />
        )}
      >
        <SquarePenIcon data-icon="inline-start" />
      </TooltipTrigger>
      <TooltipContent>
        {canStartAgent ? t('ai.newConversation') : unavailableReason ?? t('agent.availability.needsTerminal')}
      </TooltipContent>
    </Tooltip>
  );
}

function SessionRow({
  summary,
  selected,
  busy,
  locale,
  onOpen,
  onArchive,
  onRename,
}: {
  readonly summary: AiSessionSummary;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly locale: string;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
  readonly onRename: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const active = summary.status === 'running' || summary.status === 'waiting';
  const terminal = summary.status === 'completed'
    || summary.status === 'failed'
    || summary.status === 'cancelled';
  const canRename = summary.kind === 'agent' && !summary.archived && !terminal;
  const canArchive = !summary.archived && !active;
  const hasActions = canRename || canArchive;
  const status = sessionStatusLabel(summary.status, t);

  return (
    <div
      className="ai-session-row"
      data-selected={selected || undefined}
      data-menu-busy={busy || undefined}
      data-status={summary.status}
      role="treeitem"
      aria-selected={selected}
    >
      <button
        type="button"
        className="ai-session-row-main"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
      >
        <span className="ai-session-row-status" data-state={summary.status} aria-hidden="true" />
        <span className="ai-session-row-title">{summary.title}</span>
        <span className="ai-session-row-time">{relativeTimeLabel(summary.updatedAt, locale)}</span>
        <span className="sr-only">{status} · {summary.scopeKey}</span>
      </button>
      {hasActions && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={(
                <DropdownMenuTrigger
                  render={(
                    <button
                      type="button"
                      className="ai-session-row-menu"
                      aria-label={t('ai.workspace.sessions.actions', { title: summary.title })}
                      disabled={busy}
                    />
                  )}
                />
              )}
            >
              {busy ? <Spinner /> : <EllipsisIcon />}
            </TooltipTrigger>
            <TooltipContent>{t('ai.workspace.sessions.actions', { title: summary.title })}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {canRename && (
                <DropdownMenuItem onClick={onRename}>
                  <PencilIcon />
                  {t('ai.workspace.sessions.rename')}
                </DropdownMenuItem>
              )}
              {canArchive && (
                <DropdownMenuItem onClick={onArchive}>
                  <ArchiveIcon />
                  {t('ai.workspace.sessions.archive')}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function AiSessionBrowser({
  compact = false,
  sessions,
  activeSessionKey = null,
  loading,
  error,
  archivingId,
  renamingId = null,
  renameError = null,
  canStartAgent = false,
  agentUnavailableReason = null,
  onBack,
  onClose,
  onNew,
  onRefresh = () => undefined,
  onOpen,
  onArchive,
  onRename,
}: {
  readonly compact?: boolean;
  readonly sessions: readonly AiSessionSummary[];
  readonly activeSessionKey?: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly archivingId: string | null;
  readonly renamingId?: string | null;
  readonly renameError?: string | null;
  readonly canStartAgent?: boolean;
  readonly agentUnavailableReason?: string | null;
  readonly onBack: () => void;
  readonly onClose?: () => void;
  readonly onNew: () => void;
  readonly onRefresh?: () => void;
  readonly onOpen: (summary: AiSessionSummary) => void;
  readonly onArchive: (summary: AiSessionSummary) => void;
  readonly onRename?: (summary: AiSessionSummary, title: string) => void;
}): React.ReactNode {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [query, setQuery] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<AiSessionSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<AiSessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [submittedTitle, setSubmittedTitle] = useState<string | null>(null);
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return sessions.filter((summary) => (
      matches(summary, filter)
      && (
        normalizedQuery.length === 0
        || summary.title.toLocaleLowerCase(locale).includes(normalizedQuery)
        || summary.scopeKey.toLocaleLowerCase(locale).includes(normalizedQuery)
      )
    ));
  }, [filter, locale, query, sessions]);

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
    <div className="ai-session-browser" data-slot="ai-session-browser" data-compact={compact || undefined}>
      {!compact && (
        <AiRouteHeader
          title={t('ai.workspace.sessions.title')}
          description={t('ai.workspace.sessions.description')}
          onBack={onBack}
          onClose={onClose}
          actions={(
            <NewSessionButton
              canStartAgent={canStartAgent}
              unavailableReason={agentUnavailableReason}
              onNew={onNew}
            />
          )}
        />
      )}

      <div className="ai-session-browser-toolbar">
        <InputGroup className="ai-session-search">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('ai.workspace.sessions.search')}
            placeholder={compact ? t('ai.workspace.sessions.search') : t('common.search')}
          />
        </InputGroup>
        <div className="ai-session-browser-filters">
          <DropdownMenu>
            <Tooltip disabled={compact}>
              <TooltipTrigger
                render={(
                  <DropdownMenuTrigger
                    render={(
                      compact ? (
                        <Button variant="ghost" size="sm" aria-label={t('ai.workspace.sessions.filter')} />
                      ) : (
                        <AiHeaderIconButton aria-label={t('ai.workspace.sessions.filter')} />
                      )
                    )}
                  />
                )}
              >
                {compact ? (
                  <>
                    {t(`ai.workspace.sessions.filter.${filter}`)}
                    <ChevronDownIcon data-icon="inline-end" />
                  </>
                ) : <FilterIcon data-icon="inline-start" />}
              </TooltipTrigger>
              <TooltipContent>{t(`ai.workspace.sessions.filter.${filter}`)}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('ai.workspace.sessions.filter')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={filter}
                  onValueChange={(value) => setFilter(value as SessionFilter)}
                >
                  {FILTERS.map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {t(`ai.workspace.sessions.filter.${value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={(
                <AiHeaderIconButton
                  disabled={loading}
                  onClick={onRefresh}
                  aria-label={t('common.refresh')}
                />
              )}
            >
              {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            </TooltipTrigger>
            <TooltipContent>{t('common.refresh')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {error && (
        <div className="ai-session-browser-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon data-icon="inline-start" />
            {t('common.retry')}
          </Button>
        </div>
      )}

      <ScrollArea className="ai-session-browser-scroll" aria-label={t('ai.workspace.sessions.title')}>
        <ScrollAreaContent className="ai-session-browser-list">
          {loading && sessions.length === 0 && <SessionBrowserLoading label={t('common.loading')} />}
          {!loading && !error && visible.length === 0 && (
            <PanelEmptyState
              icon={query ? <SearchIcon /> : <ArchiveIcon />}
              title={query ? t('common.noSearchResults') : t('ai.workspace.sessions.emptyTitle')}
              description={query ? undefined : t('ai.workspace.sessions.emptyDescription')}
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canStartAgent}
                  onClick={onNew}
                >
                  <SquarePenIcon data-icon="inline-start" />
                  {t('ai.newConversation')}
                </Button>
              )}
            />
          )}
          {visible.length > 0 && (
            <div role="tree" aria-label={t('ai.workspace.sessions.title')}>
              {visible.map((summary) => (
                <SessionRow
                  key={`${summary.kind}:${summary.id}`}
                  summary={summary}
                  selected={`${summary.kind}:${summary.id}` === activeSessionKey}
                  busy={archivingId === summary.id || renamingId === summary.id}
                  locale={locale}
                  onOpen={() => onOpen(summary)}
                  onArchive={() => setArchiveTarget(summary)}
                  onRename={() => {
                    setRenameTarget(summary);
                    setRenameValue(summary.title);
                    setSubmittedTitle(null);
                  }}
                />
              ))}
            </div>
          )}
        </ScrollAreaContent>
      </ScrollArea>

      <ConfirmationDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}
        title={t('ai.workspace.sessions.archiveConfirmTitle')}
        description={t('ai.workspace.sessions.archiveConfirmDescription', { title: archiveTarget?.title ?? '' })}
        confirmLabel={t('ai.workspace.sessions.archive')}
        confirmVariant="destructive"
        confirmDisabled={!archiveTarget || archivingId !== null}
        onConfirm={() => {
          if (archiveTarget) onArchive(archiveTarget);
          setArchiveTarget(null);
        }}
      />

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
