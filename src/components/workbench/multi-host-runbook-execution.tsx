import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { LocaleKey } from '@/locales';
import { ensureKeychainKeyForProfile } from '@/lib/keychain-key-prompt';
import {
  activeMultiHostRunbookBatch,
  activeMultiHostRunbookOperationIds,
  applyMultiHostRunbookResult,
  approveMultiHostRunbookHost,
  canApproveMultiHostRunbookHost,
  canRetryMultiHostRunbookHost,
  createMultiHostSyntheticResult,
  failMultiHostRunbookHost,
  isMultiHostRunbookHostTerminal,
  isMultiHostRunbookTaskTerminal,
  multiHostRunbookBatchCount,
  planMultiHostRunbookDispatches,
  profileMatchesRunbookTarget,
  requestCancelMultiHostRunbookHost,
  requestCancelMultiHostRunbookTask,
  retryMultiHostRunbookHosts,
  summarizeMultiHostRunbookTask,
} from '@/lib/multi-host-runbook';
import { createOperationId } from '@/lib/operation-id';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/password-prompt';
import {
  buildRemoteConnectionRequest,
  invokeCancelRunbookStep,
  invokeExecuteRunbookStep,
} from '@/lib/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import type {
  MultiHostRunbookDispatch,
  MultiHostRunbookHost,
  MultiHostRunbookHostStatus,
  MultiHostRunbookOutcome,
  MultiHostRunbookTask,
} from '@/types/multi-host-runbook';
import type { RunbookRisk, RunbookRunItem } from '@/types/runbook';

interface MultiHostRunbookExecutionProps {
  initialTask: MultiHostRunbookTask;
  profiles: ConnectionProfile[];
  onTaskChange: (task: MultiHostRunbookTask) => void;
}

interface CachedPreparedProfile {
  profileWithSavedSecrets: ConnectionProfile;
  preparedProfile: ConnectionProfile;
}

function outcomeVariant(outcome: MultiHostRunbookOutcome): 'default' | 'secondary' | 'destructive' {
  if (outcome === 'succeeded') return 'default';
  if (outcome === 'failed' || outcome === 'cancelled') return 'destructive';
  return 'secondary';
}

function hostStatusVariant(status: MultiHostRunbookHostStatus): 'default' | 'outline' | 'secondary' | 'destructive' {
  if (status === 'succeeded') return 'default';
  if (['failed', 'cancelled', 'timedOut', 'staleEvidence', 'identityMismatch'].includes(status)) return 'destructive';
  if (['queuedPreflight', 'awaitingApproval'].includes(status)) return 'outline';
  return 'secondary';
}

function riskVariant(risk: RunbookRisk): 'outline' | 'secondary' | 'destructive' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'stateChange') return 'secondary';
  return 'outline';
}

function itemStatusVariant(status: RunbookRunItem['status']): 'default' | 'outline' | 'secondary' | 'destructive' {
  if (status === 'completed') return 'default';
  if (['failed', 'rejected', 'cancelled', 'timedOut'].includes(status)) return 'destructive';
  if (status === 'running' || status === 'awaitingApproval') return 'secondary';
  return 'outline';
}

export const MultiHostRunbookExecution: React.FC<MultiHostRunbookExecutionProps> = ({
  initialTask,
  profiles,
  onTaskChange,
}) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const [task, setTask] = useState(initialTask);
  const [confirmingProfileId, setConfirmingProfileId] = useState<string>();
  const taskRef = useRef(initialTask);
  const pumpingRef = useRef(false);
  const disposedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const preparedProfilesRef = useRef(new Map<string, CachedPreparedProfile>());

  const publish = (next: MultiHostRunbookTask): void => {
    taskRef.current = next;
    setTask(next);
    onTaskChange(next);
  };

  const prepareProfile = async (
    dispatch: MultiHostRunbookDispatch,
  ): Promise<CachedPreparedProfile | undefined> => {
    const currentProfile = useProfileStore.getState().getProfile(dispatch.profileId);
    if (!currentProfile || !profileMatchesRunbookTarget(currentProfile, dispatch.target)) {
      publish(failMultiHostRunbookHost(
        taskRef.current,
        dispatch.profileId,
        'targetChanged',
        t('runbook.multi.targetChanged'),
      ));
      return undefined;
    }
    const cached = preparedProfilesRef.current.get(dispatch.profileId);
    if (cached && profileMatchesRunbookTarget(cached.preparedProfile, dispatch.target)) return cached;

    const profileWithSavedSecrets = await useProfileStore.getState().ensurePassword(currentProfile);
    const withPassword = await promptForMissingPassword(profileWithSavedSecrets);
    if (!withPassword) {
      publish(applyMultiHostRunbookResult(
        taskRef.current,
        dispatch.profileId,
        createMultiHostSyntheticResult(dispatch, 'cancelled', t('runbook.credentialCancelled')),
      ));
      return undefined;
    }
    const preparedProfile = await ensureKeychainKeyForProfile(withPassword);
    if (!preparedProfile) {
      publish(applyMultiHostRunbookResult(
        taskRef.current,
        dispatch.profileId,
        createMultiHostSyntheticResult(dispatch, 'cancelled', t('runbook.credentialCancelled')),
      ));
      return undefined;
    }
    const prepared = { profileWithSavedSecrets, preparedProfile };
    preparedProfilesRef.current.set(dispatch.profileId, prepared);
    return prepared;
  };

  const pump = async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (!disposedRef.current) {
        const planned = planMultiHostRunbookDispatches(
          taskRef.current,
          () => createOperationId('multi-host-runbook'),
        );
        publish(planned.task);
        if (planned.dispatches.length === 0) return;

        const preparedDispatches: Array<{
          dispatch: MultiHostRunbookDispatch;
          prepared: CachedPreparedProfile;
        }> = [];
        for (const dispatch of planned.dispatches) {
          if (disposedRef.current) return;
          try {
            const prepared = await prepareProfile(dispatch);
            const host = taskRef.current.hosts.find((entry) => entry.target.profileId === dispatch.profileId);
            if (prepared && host && host.activeOperationId === dispatch.operationId && host.status !== 'cancelling') {
              preparedDispatches.push({ dispatch, prepared });
            } else if (prepared && host?.status === 'cancelling') {
              publish(applyMultiHostRunbookResult(
                taskRef.current,
                dispatch.profileId,
                createMultiHostSyntheticResult(dispatch, 'cancelled', t('runbook.multi.hostCancelled')),
              ));
            }
          } catch (error) {
            publish(applyMultiHostRunbookResult(
              taskRef.current,
              dispatch.profileId,
              createMultiHostSyntheticResult(
                dispatch,
                'failed',
                error instanceof Error ? error.message : String(error),
              ),
            ));
          }
        }

        if (disposedRef.current) return;

        const settled = await Promise.all(preparedDispatches.map(async ({ dispatch, prepared }) => {
          try {
            const value = await invokeExecuteRunbookStep({
              operationId: dispatch.operationId,
              runId: dispatch.runId,
              sourceDigest: dispatch.sourceDigest,
              runbookText: dispatch.runbookText,
              itemId: dispatch.itemId,
              itemKind: dispatch.itemKind,
              profileId: dispatch.profileId,
              authorized: true,
              approvedRisk: dispatch.risk,
              variableValues: { ...dispatch.variableValues },
              timeoutMs: dispatch.timeoutMs,
              connection: buildRemoteConnectionRequest(prepared.preparedProfile),
            });
            return { dispatch, prepared, value };
          } catch (error) {
            return {
              dispatch,
              prepared,
              value: createMultiHostSyntheticResult(
                dispatch,
                'failed',
                error instanceof Error ? error.message : String(error),
              ),
            };
          }
        }));

        if (disposedRef.current) return;

        let next = taskRef.current;
        for (const entry of settled) {
          next = applyMultiHostRunbookResult(next, entry.dispatch.profileId, entry.value);
        }
        publish(next);
        for (const entry of settled) {
          if (entry.value.status === 'success') {
            try {
              await persistPromptedPassword(
                entry.prepared.profileWithSavedSecrets,
                entry.prepared.preparedProfile,
              );
            } catch {
              showError(t('runbook.multi.credentialSaveFailed'));
            }
          }
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  };

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    disposedRef.current = false;
    void pump();
    return () => {
      setTimeout(() => {
        // StrictMode immediately mounts the effect again with a newer generation.
        if (lifecycleGenerationRef.current !== generation) return;
        disposedRef.current = true;
        const current = taskRef.current;
        const operationIds = activeMultiHostRunbookOperationIds(current);
        taskRef.current = requestCancelMultiHostRunbookTask(current);
        preparedProfilesRef.current.clear();
        for (const operationId of operationIds) {
          void invokeCancelRunbookStep(operationId).catch(() => undefined);
        }
      }, 0);
    };
  // The initial task is frozen by the parent key and the scheduler has one owner.
  }, []);

  const approveHost = (profileId: string): void => {
    setConfirmingProfileId(undefined);
    const next = approveMultiHostRunbookHost(taskRef.current, profileId);
    publish(next);
    void pump();
  };

  const handleApprove = (host: MultiHostRunbookHost): void => {
    const item = host.run.items.find((entry) => entry.id === host.run.activeItemId);
    if (item?.risk === 'destructive') setConfirmingProfileId(host.target.profileId);
    else approveHost(host.target.profileId);
  };

  const cancelHost = async (profileId: string): Promise<void> => {
    const host = taskRef.current.hosts.find((entry) => entry.target.profileId === profileId);
    const operationId = host?.activeOperationId;
    publish(requestCancelMultiHostRunbookHost(taskRef.current, profileId));
    if (!operationId) return;
    try {
      await invokeCancelRunbookStep(operationId);
    } catch {
      showError(t('runbook.cancelFailed'));
    }
  };

  const cancelTask = async (): Promise<void> => {
    const operationIds = activeMultiHostRunbookOperationIds(taskRef.current);
    publish(requestCancelMultiHostRunbookTask(taskRef.current));
    const results = await Promise.allSettled(operationIds.map(invokeCancelRunbookStep));
    if (results.some((entry) => entry.status === 'rejected')) showError(t('runbook.cancelFailed'));
  };

  const retryHost = (profileId: string): void => {
    const next = retryMultiHostRunbookHosts(
      taskRef.current,
      [profileId],
      useProfileStore.getState().profiles,
    );
    if (next === taskRef.current) return;
    preparedProfilesRef.current.delete(profileId);
    publish(next);
    void pump();
  };

  const summary = summarizeMultiHostRunbookTask(task);
  const activeBatch = activeMultiHostRunbookBatch(task);
  const batchCount = multiHostRunbookBatchCount(task);
  const confirmingHost = task.hosts.find((host) => host.target.profileId === confirmingProfileId);
  const confirmingItem = confirmingHost?.run.items.find((item) => item.id === confirmingHost.run.activeItemId);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('runbook.multi.executionTitle')}</CardTitle>
          <CardDescription>
            {t('runbook.multi.executionDescription', {
              tag: task.selectedTag,
              concurrency: task.config.concurrencyLimit,
              batchSize: task.config.batchSize,
            })}
          </CardDescription>
          <CardAction>
            <Badge variant={outcomeVariant(summary.outcome)}>
              {t(`runbook.multi.outcome.${summary.outcome}` as LocaleKey)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {summary.outcome === 'partialSuccess' && (
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>{t('runbook.multi.partialSuccessTitle')}</AlertTitle>
              <AlertDescription>{t('runbook.multi.partialSuccessDescription')}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{t('runbook.multi.summary.total', { count: summary.total })}</Badge>
            <Badge variant="default">{t('runbook.multi.summary.succeeded', { count: summary.succeeded })}</Badge>
            <Badge variant="destructive">
              {t('runbook.multi.summary.notSucceeded', { count: summary.total - summary.succeeded - summary.pending })}
            </Badge>
            <Badge variant="secondary">{t('runbook.multi.summary.pending', { count: summary.pending })}</Badge>
            {activeBatch !== undefined && (
              <Badge variant="outline">
                {t('runbook.multi.summary.batch', { current: activeBatch + 1, total: batchCount })}
              </Badge>
            )}
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t('runbook.multi.safetyBoundary')}</span>
          {!isMultiHostRunbookTaskTerminal(task) && (
            <Button variant="destructive" size="sm" onClick={() => void cancelTask()}>
              <CircleStopIcon data-icon="inline-start" />
              {t('runbook.multi.cancelAll')}
            </Button>
          )}
        </CardFooter>
      </Card>

      {task.hosts.map((host) => {
        const activeItem = host.run.items.find((item) => item.id === host.run.activeItemId);
        const retryable = canRetryMultiHostRunbookHost(task, host.target.profileId, profiles);
        const canCancel = !isMultiHostRunbookHostTerminal(host) && host.status !== 'cancelling';
        return (
          <Card key={host.target.profileId}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {host.target.name}
                <Badge variant="outline">{t('runbook.multi.hostAttempt', { count: host.attempt })}</Badge>
              </CardTitle>
              <CardDescription>
                {host.target.username}@{host.target.host}:{host.target.port} · {t('runbook.multi.hostBatch', { count: host.batchIndex + 1 })}
              </CardDescription>
              <CardAction>
                <Badge variant={hostStatusVariant(host.status)}>
                  {t(`runbook.multi.status.${host.status}` as LocaleKey)}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {host.failure && (
                <Alert variant="destructive">
                  <XCircleIcon />
                  <AlertTitle>{t(`runbook.multi.failure.${host.failure.kind}` as LocaleKey)}</AlertTitle>
                  <AlertDescription>{host.failure.message}</AlertDescription>
                </Alert>
              )}
              {activeItem && ['awaitingApproval', 'queuedStep'].includes(host.status) && (
                <Alert variant={activeItem.risk === 'destructive' ? 'destructive' : 'default'}>
                  <ShieldAlertIcon />
                  <AlertTitle className="flex items-center gap-2">
                    {activeItem.description}
                    <Badge variant={riskVariant(activeItem.risk)}>
                      {t(`runbook.risk.${activeItem.risk}` as LocaleKey)}
                    </Badge>
                  </AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>{t('runbook.impact')}: {activeItem.impact}</span>
                      {activeItem.rollback && (
                        <span>{t('runbook.rollback')}: {activeItem.rollback}</span>
                      )}
                      <code className="break-all rounded-md bg-muted p-2 text-foreground">{activeItem.commandPreview}</code>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-2">
                {host.run.items.map((item) => (
                  <Card key={`${host.target.profileId}:${item.id}`} size="sm">
                    <CardHeader>
                      <CardTitle>{item.description}</CardTitle>
                      <CardDescription>{item.commandPreview}</CardDescription>
                      <CardAction>
                        <Badge variant={itemStatusVariant(item.status)}>
                          {t(`runbook.status.${item.status}` as LocaleKey)}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    {(item.evidence || item.error) && (
                      <CardContent className="flex flex-col gap-1 text-xs">
                        {item.evidence && (
                          <>
                            <span>{t('runbook.evidenceOperation')}: {item.evidence.operationId}</span>
                            <span>
                              {t('runbook.evidenceTarget')}: {item.evidence.username}@{item.evidence.host}:{item.evidence.port}
                            </span>
                            <span>
                              {t('runbook.evidenceCompletedAt')}: {new Date(item.evidence.completedAt).toLocaleString()}
                            </span>
                          </>
                        )}
                        {item.evidence?.exitCode !== undefined && <span>exit {item.evidence.exitCode}</span>}
                        {item.evidence?.stdout && (
                          <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stdout}</code>
                        )}
                        {item.evidence?.stderr && (
                          <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stderr}</code>
                        )}
                        {item.error && <span className="text-destructive">{item.error}</span>}
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <span className="text-xs text-muted-foreground">{host.target.profileId}</span>
              <div className="flex gap-2">
                {canCancel && (
                  <Button size="sm" variant="outline" onClick={() => void cancelHost(host.target.profileId)}>
                    <CircleStopIcon data-icon="inline-start" />
                    {t('runbook.cancel')}
                  </Button>
                )}
                {canApproveMultiHostRunbookHost(task, host.target.profileId) && (
                  <Button
                    size="sm"
                    variant={activeItem?.risk === 'destructive' ? 'destructive' : 'default'}
                    onClick={() => handleApprove(host)}
                  >
                    <PlayIcon data-icon="inline-start" />
                    {t('runbook.multi.approveHost')}
                  </Button>
                )}
                {['preflighting', 'runningStep'].includes(host.status) && (
                  <Button size="sm" variant="secondary" disabled>
                    <Spinner data-icon="inline-start" />
                    {t('runbook.multi.executingHost')}
                  </Button>
                )}
                {host.status === 'succeeded' && (
                  <Badge variant="default">
                    <CheckCircle2Icon data-icon="inline-start" />
                    {t('runbook.multi.hostSucceeded')}
                  </Badge>
                )}
                {retryable && (
                  <Button size="sm" variant="outline" onClick={() => retryHost(host.target.profileId)}>
                    <RotateCcwIcon data-icon="inline-start" />
                    {t('runbook.multi.retryHost')}
                  </Button>
                )}
              </div>
            </CardFooter>
          </Card>
        );
      })}

      <AlertDialog open={Boolean(confirmingProfileId)} onOpenChange={(open) => !open && setConfirmingProfileId(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('runbook.multi.destructiveHostTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('runbook.multi.destructiveHostDescription', { host: confirmingHost?.target.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmingItem && (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>{confirmingItem.impact}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  {confirmingItem.rollback && (
                    <span>{t('runbook.rollback')}: {confirmingItem.rollback}</span>
                  )}
                  <code className="break-all">{confirmingItem.commandPreview}</code>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmingProfileId && approveHost(confirmingProfileId)}
            >
              {t('runbook.confirmDestructive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
