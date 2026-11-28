import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EyeIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { deleteAgentSessionRecord, listAllAgentSessionRecords } from '@/lib/ai/session-records';
import { loadHistoricalSources, withHistoricalConversation } from '@/lib/ai/historical-continuation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AiSessionAdapter, AiSessionView } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionListItem } from '@/types/agent-session';
import { AiConversation } from './workspace/ai-conversation';
import { AiArtifactDetails } from './workspace/ai-artifact-details';
import { AiSessionRecordsList } from './ai-session-records-list';
import { AiSessionRecordsDeleteAll } from './ai-session-records-delete-all';

type RecordFilter = 'all' | 'terminal' | 'workbench' | 'archived';
type RecordDetail =
  | { kind: 'artifact'; node: AiConversationNodeOf<'artifact'> }
  | { kind: 'storedOutput'; sessionId: string; artifactId: string };

const FILTERS = ['all', 'terminal', 'workbench', 'archived'] as const;

function recordTitle(item: AgentSessionListItem): string {
  return item.header.title || item.header.goal || item.header.sessionId;
}

function recordScope(item: AgentSessionListItem): 'terminal' | 'workbench' {
  return item.header.target?.targetId === 'workbench-ai' ? 'workbench' : 'terminal';
}

function recordStatus(item: AgentSessionListItem, t: (key: LocaleKey) => string): string {
  if (item.archived) return t('settings.ai.records.archived');
  if (item.status === 'idle') return t('agent.session.status.idle');
  if (item.status === 'waiting') return t('agent.session.status.waiting');
  return t(`agent.outcome.${item.status}`);
}

export function AiSessionRecordRow({ item, locale, t, disabled, onView, onDelete }: {
  readonly item: AgentSessionListItem;
  readonly locale: string;
  readonly t: ReturnType<typeof useI18n>['t'];
  readonly disabled: boolean;
  readonly onView: (item: AgentSessionListItem) => void;
  readonly onDelete: (item: AgentSessionListItem) => void;
}) {
  const title = recordTitle(item);
  const target = item.header.target;
  const scope = recordScope(item);
  return (
    <div data-slot="session-record-row" className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {t(`settings.ai.records.filter.${scope}`)}
          {target?.label ? ` · ${target.label}` : ''}
          {' · '}{new Date(item.header.createdAtUnixMs).toLocaleString(locale)}
          {' · '}{recordStatus(item, t)}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => onView(item)} disabled={disabled} aria-label={t('settings.ai.records.view')} />}>
          <EyeIcon data-icon="inline-start" />
        </TooltipTrigger>
        <TooltipContent>{t('settings.ai.records.view')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          size="icon-sm"
          disabled={disabled}
          onClick={() => onDelete(item)}
          aria-label={t('settings.ai.records.deleteNamed', { title })}
        />}>
          <Trash2Icon data-icon="inline-start" />
        </TooltipTrigger>
        <TooltipContent>{t('common.delete')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function AiSessionRecordLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Spinner aria-hidden="true" />
        <span>{label}</span>
      </span>
    </div>
  );
}

export function AiSessionRecordsDialog({ onOpenChange }: {
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const [records, setRecords] = useState<AgentSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RecordFilter>('all');
  const [selected, setSelected] = useState<AgentSessionListItem | null>(null);
  const [view, setView] = useState<AiSessionView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState(false);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSessionListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const adapterRef = useRef<AiSessionAdapter<'agent'> | null>(null);
  const viewAbortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const viewRequestRef = useRef(0);

  const closeView = useCallback(() => {
    viewRequestRef.current += 1;
    viewAbortRef.current?.abort();
    viewAbortRef.current = null;
    adapterRef.current?.dispose();
    adapterRef.current = null;
    setSelected(null);
    setView(null);
    setViewLoading(false);
    setViewError(false);
    setDetail(null);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(false);
    try {
      const next = await listAllAgentSessionRecords();
      if (request === requestRef.current) setRecords(next);
    } catch {
      if (request === requestRef.current) setError(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      viewRequestRef.current += 1;
      viewAbortRef.current?.abort();
      viewAbortRef.current = null;
      adapterRef.current?.dispose();
      adapterRef.current = null;
    };
  }, [refresh]);

  const openView = useCallback(async (item: AgentSessionListItem) => {
    closeView();
    const request = ++viewRequestRef.current;
    const controller = new AbortController();
    viewAbortRef.current = controller;
    setSelected(item);
    setViewLoading(true);
    try {
      const { createAgentSessionAdapter } = await import('@/lib/ai/agent-session-adapter');
      if (request !== viewRequestRef.current || controller.signal.aborted) return;
      const adapter = createAgentSessionAdapter();
      adapterRef.current = adapter;
      const next = await adapter.open(item.header.sessionId);
      if (request !== viewRequestRef.current || controller.signal.aborted) return;
      const sources = await loadHistoricalSources(adapter, next, controller.signal);
      if (request === viewRequestRef.current && !controller.signal.aborted) {
        setView(withHistoricalConversation(next, sources));
      }
    } catch {
      if (request === viewRequestRef.current && !controller.signal.aborted) setViewError(true);
    } finally {
      if (request === viewRequestRef.current) setViewLoading(false);
    }
  }, [closeView]);

  const deleteRecord = useCallback(async () => {
    const target = deleteTarget;
    if (!target || busyId || deletingAll) return;
    setDeleteTarget(null);
    const sessionId = target.header.sessionId;
    if (records.some((item) => item.header.continuedFromSessionId === sessionId)) {
      showError(t('settings.ai.records.deleteReferenced'));
      return;
    }
    setBusyId(sessionId);
    try {
      await deleteAgentSessionRecord(target);
      if (selected?.header.sessionId === sessionId) closeView();
      window.dispatchEvent(new CustomEvent('shellspan:ai-session-deleted', { detail: { sessionId } }));
      setRecords((current) => current.filter((item) => item.header.sessionId !== sessionId));
      showSuccess(t('settings.ai.records.deleted'));
      void refresh();
    } catch {
      showError(t('settings.ai.records.deleteFailed'));
      void refresh();
    } finally {
      setBusyId(null);
    }
  }, [busyId, closeView, deleteTarget, deletingAll, records, refresh, selected?.header.sessionId, showError, showSuccess, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return records.filter((item) => {
      const scope = recordScope(item);
      if (filter === 'archived' ? !item.archived : filter !== 'all' && filter !== scope) return false;
      if (!needle) return true;
      return [recordTitle(item), item.header.target?.label, item.header.target?.host, item.header.sessionId]
        .some((value) => value?.toLocaleLowerCase(locale).includes(needle));
    });
  }, [filter, locale, query, records]);

  const filterItems = useMemo(
    () => FILTERS.map((value) => ({ value, label: t(`settings.ai.records.filter.${value}`) })),
    [t],
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!deletingAll) onOpenChange(open); }}>
      <DialogContent className="flex h-[min(48rem,calc(100vh-2rem))] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-border/60 bg-card p-0 [&_[data-slot=dialog-close]]:size-8 sm:rounded-2xl">
        <DialogHeader className="shrink-0 gap-1 border-b-[0.5px] border-border/50 px-5 py-3.5 pr-12 text-left">
          <DialogTitle className="text-sm font-semibold text-foreground">{t('settings.ai.records.title')}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{t('settings.ai.records.description')}</DialogDescription>
        </DialogHeader>

        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b-[0.5px] border-border/50 px-5 py-2.5">
              <Button variant="ghost" size="sm" onClick={closeView} aria-label={t('settings.ai.records.back')}>
                {t('settings.ai.records.back')}
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{view?.summary.title ?? recordTitle(selected)}</span>
              <Button variant="destructiveSoft" size="sm" disabled={busyId !== null} onClick={() => setDeleteTarget(selected)}>
                {t('common.delete')}
              </Button>
            </div>
            <div className="ai-panel-shell ai-workspace-root ai-session-records-detail flex min-h-0 min-w-0 flex-1 flex-col">
              {detail?.kind === 'artifact' ? (
                <AiArtifactDetails
                  sessionId={detail.node.sessionId}
                  node={detail.node}
                  load={(sessionId, artifactId, maxBytes) => adapterRef.current?.loadArtifact(sessionId, artifactId, maxBytes)
                    ?? Promise.reject(new Error('Session viewer closed'))}
                  onBack={() => setDetail(null)}
                />
              ) : detail?.kind === 'storedOutput' ? (
                <AiArtifactDetails
                  sessionId={detail.sessionId}
                  node={null}
                  artifactId={detail.artifactId}
                  title={t('ai.workspace.details.output')}
                  load={(sessionId, artifactId, maxBytes) => adapterRef.current?.loadArtifact(sessionId, artifactId, maxBytes)
                    ?? Promise.reject(new Error('Session viewer closed'))}
                  onBack={() => setDetail(null)}
                />
              ) : viewLoading ? <AiSessionRecordLoading label={t('common.loading')} />
                : viewError ? <p role="alert" className="p-4 text-sm text-destructive">{t('settings.ai.records.viewFailed')}</p>
                  : view ? (
                    <AiConversation
                      nodes={view.nodes.filter((node) => node.kind !== 'systemPrompt')}
                      status={view.status}
                      throughSeq={view.throughSeq}
                      runningIndicator="none"
                      onOpenStoredOutput={(node, artifactId) => setDetail({ kind: 'storedOutput', sessionId: node.sessionId, artifactId })}
                      onOpenArtifact={(node) => setDetail({ kind: 'artifact', node })}
                    />
                  ) : null}
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-border/50 px-5 py-2.5">
              <div className="relative min-w-44 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  className="h-8 rounded-lg border-transparent bg-muted/50 pl-8 focus-visible:border-border/60 focus-visible:bg-card"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('settings.ai.records.search')}
                  aria-label={t('settings.ai.records.search')}
                />
              </div>
              <Select items={filterItems} value={filter} onValueChange={(value) => { if (value) setFilter(value as RecordFilter); }}>
                <SelectTrigger variant="ghost" size="sm" aria-label={t('settings.ai.records.filter')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {filterItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button variant="soft" size="icon-sm" className="rounded-lg" onClick={() => void refresh()} disabled={loading || deletingAll || busyId !== null} aria-label={t('common.refresh')}>
                {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              </Button>
              <AiSessionRecordsDeleteAll
                records={records}
                disabled={loading || error || busyId !== null}
                t={t}
                onBusyChange={setDeletingAll}
                onDeleted={(sessionId) => {
                  setRecords((current) => current.filter((item) => item.header.sessionId !== sessionId));
                  window.dispatchEvent(new CustomEvent('shellspan:ai-session-deleted', { detail: { sessionId } }));
                }}
                onSettled={refresh}
              />
            </div>
            <AiSessionRecordsList
              key={JSON.stringify([query, filter])}
              records={visible}
              notices={[
                loading && records.length === 0 && <div key="loading" role="status" className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>,
                error && <p key="error" role="alert" className="text-sm text-destructive">{t('settings.ai.records.loadFailed')}</p>,
                !loading && !error && visible.length === 0 && <p key="empty" className="py-8 text-center text-sm text-muted-foreground">{t('settings.ai.records.empty')}</p>,
              ].filter(Boolean)}
              renderRecord={(item) => (
                <AiSessionRecordRow
                  item={item}
                  locale={locale}
                  t={t}
                  disabled={busyId !== null || deletingAll}
                  onView={openView}
                  onDelete={setDeleteTarget}
                />
              )}
            />
          </>
        )}
      </DialogContent>

      <ConfirmationDialog
        textOnlyActions
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('settings.ai.records.deleteTitle')}
        description={t(
          deleteTarget && !deleteTarget.ended && !deleteTarget.archived
            ? 'settings.ai.records.deleteActiveDescription'
            : 'settings.ai.records.deleteDescription',
          { title: deleteTarget ? recordTitle(deleteTarget) : '' },
        )}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
        media={<Trash2Icon />}
        mediaVariant="destructive"
        onConfirm={() => void deleteRecord()}
      />
    </Dialog>
  );
}
