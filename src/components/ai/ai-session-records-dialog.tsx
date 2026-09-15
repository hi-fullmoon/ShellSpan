import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeftIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CompactDialogHeader } from '@/components/ui/compact-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { listAllAgentSessionRecords } from '@/lib/ai/session-records';
import { loadHistoricalSources, withHistoricalConversation } from '@/lib/ai/historical-continuation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AiSessionAdapter, AiSessionView } from '@/lib/ai/session-adapter';
import {
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeDeleteAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import type { LocaleKey } from '@/locales';
import type { AgentSessionListItem } from '@/types/agent-session';
import { AiConversation } from './workspace/ai-conversation';
import { AiToolDetails } from './workspace/ai-tool-details';
import { AiArtifactDetails } from './workspace/ai-artifact-details';

type RecordFilter = 'all' | 'terminal' | 'workbench' | 'archived';
type RecordDetail =
  | { kind: 'tool'; node: AiConversationNodeOf<'tool'> }
  | { kind: 'artifact'; node: AiConversationNodeOf<'artifact'> };

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
  const adapterRef = useRef<AiSessionAdapter<'agent'> | null>(null);
  const requestRef = useRef(0);
  const viewRequestRef = useRef(0);

  const closeView = useCallback(() => {
    viewRequestRef.current += 1;
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
      adapterRef.current?.dispose();
      adapterRef.current = null;
    };
  }, [refresh]);

  const openView = useCallback(async (item: AgentSessionListItem) => {
    closeView();
    const request = ++viewRequestRef.current;
    setSelected(item);
    setViewLoading(true);
    try {
      const { createAgentSessionAdapter } = await import('@/lib/ai/agent-session-adapter');
      if (request !== viewRequestRef.current) return;
      const adapter = createAgentSessionAdapter();
      adapterRef.current = adapter;
      const next = await adapter.open(item.header.sessionId);
      const sources = await loadHistoricalSources(adapter, next);
      if (request === viewRequestRef.current) setView(withHistoricalConversation(next, sources));
    } catch {
      if (request === viewRequestRef.current) setViewError(true);
    } finally {
      if (request === viewRequestRef.current) setViewLoading(false);
    }
  }, [closeView]);

  const deleteRecord = useCallback(async () => {
    const target = deleteTarget;
    if (!target || busyId) return;
    setDeleteTarget(null);
    const sessionId = target.header.sessionId;
    if (records.some((item) => item.header.continuedFromSessionId === sessionId)) {
      showError(t('settings.ai.records.deleteReferenced'));
      return;
    }
    setBusyId(sessionId);
    try {
      if (!target.archived) {
        if (!target.ended) await invokeCancelAgentRuntime({ sessionId });
        await invokeArchiveAgentRuntimeSession({ sessionId });
      }
      await invokeDeleteAgentRuntimeSession({ sessionId });
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
  }, [busyId, closeView, deleteTarget, records, refresh, selected?.header.sessionId, showError, showSuccess, t]);

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

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(48rem,calc(100vh-2rem))] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-app-border/70 bg-card p-0 [&_[data-slot=dialog-close]]:size-8 sm:rounded-xl">
        <CompactDialogHeader
          title={t('settings.ai.records.title')}
          description={t('settings.ai.records.description')}
        />

        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-4 py-2">
              <Button variant="ghost" size="sm" className="gap-1" onClick={closeView} aria-label={t('settings.ai.records.back')}>
                <ChevronLeftIcon data-icon="inline-start" />
                {t('settings.ai.records.back')}
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{view?.summary.title ?? recordTitle(selected)}</span>
              <Button variant="destructiveOutline" size="sm" disabled={busyId !== null} onClick={() => setDeleteTarget(selected)}>
                {t('common.delete')}
              </Button>
            </div>
            <div className="ai-panel-shell ai-workspace-root min-h-0 flex-1">
              {detail?.kind === 'tool' ? (
                <AiToolDetails node={detail.node} onBack={() => setDetail(null)} />
              ) : detail?.kind === 'artifact' ? (
                <AiArtifactDetails
                  sessionId={detail.node.sessionId}
                  node={detail.node}
                  load={(sessionId, artifactId, maxBytes) => adapterRef.current?.loadArtifact(sessionId, artifactId, maxBytes)
                    ?? Promise.reject(new Error('Session viewer closed'))}
                  onBack={() => setDetail(null)}
                />
              ) : viewLoading ? <div className="flex flex-1 items-center justify-center"><Spinner /></div>
                : viewError ? <p role="alert" className="p-4 text-sm text-destructive">{t('settings.ai.records.viewFailed')}</p>
                  : view ? (
                    <AiConversation
                      nodes={view.nodes.filter((node) => node.kind !== 'systemPrompt')}
                      status={view.status}
                      throughSeq={view.throughSeq}
                      runningIndicator="none"
                      onOpenTool={(node) => setDetail({ kind: 'tool', node })}
                      onOpenArtifact={(node) => setDetail({ kind: 'artifact', node })}
                    />
                  ) : null}
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
              <div className="relative min-w-44 flex-1">
                <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  className="pl-8"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('settings.ai.records.search')}
                  aria-label={t('settings.ai.records.search')}
                />
              </div>
              <Select value={filter} onValueChange={(value) => setFilter(value as RecordFilter)}>
                <SelectTrigger aria-label={t('settings.ai.records.filter')} className="w-36">
                  <SelectValue>{t(`settings.ai.records.filter.${filter}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>{t(`settings.ai.records.filter.${value}`)}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} aria-label={t('common.refresh')}>
                {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <ScrollAreaContent className="flex flex-col gap-2 p-4" style={{ minWidth: 0 }}>
                {loading && records.length === 0 && <div role="status" className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>}
                {error && <p role="alert" className="text-sm text-destructive">{t('settings.ai.records.loadFailed')}</p>}
                {!loading && !error && visible.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('settings.ai.records.empty')}</p>
                )}
                {visible.map((item) => {
                  const title = recordTitle(item);
                  const target = item.header.target;
                  const scope = recordScope(item);
                  return (
                    <div key={item.header.sessionId} className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{title}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {t(`settings.ai.records.filter.${scope}`)}
                          {target?.label ? ` · ${target.label}` : ''}
                          {' · '}{new Date(item.header.createdAtUnixMs).toLocaleString(locale)}
                          {' · '}{recordStatus(item, t)}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => void openView(item)} disabled={busyId !== null}>
                        {t('settings.ai.records.view')}
                      </Button>
                      <Button
                        variant="destructiveOutline"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => setDeleteTarget(item)}
                        aria-label={t('settings.ai.records.deleteNamed', { title })}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  );
                })}
              </ScrollAreaContent>
            </ScrollArea>
          </>
        )}
      </DialogContent>

      <ConfirmationDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('settings.ai.records.deleteTitle', { title: deleteTarget ? recordTitle(deleteTarget) : '' })}
        description={t(deleteTarget && !deleteTarget.ended && !deleteTarget.archived
          ? 'settings.ai.records.deleteActiveDescription'
          : 'settings.ai.records.deleteDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
        media={<Trash2Icon />}
        mediaVariant="destructive"
        onConfirm={() => void deleteRecord()}
      />
    </Dialog>
  );
}
