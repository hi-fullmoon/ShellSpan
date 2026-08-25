import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BracesIcon,
  Clock3Icon,
  ListChecksIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  WorkflowIcon,
  XCircleIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { LocaleKey } from '@/locales';
import { ensureKeychainKeyForProfile } from '@/lib/keychain-key-prompt';
import { createOperationId } from '@/lib/operation-id';
import { recordOperationHistoryTransition } from '@/lib/operation-history';
import {
  AI_RUNBOOK_DRAFT_EVENT,
  consumePendingAgentRunbookDraft,
  type AiRunbookDraftDetail,
} from '@/lib/diagnostic-agent';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/password-prompt';
import {
  createMultiHostRunbookTask,
  isMultiHostRunbookTaskTerminal,
  listMultiHostRunbookTags,
  MULTI_HOST_MAX_BATCH_SIZE,
  MULTI_HOST_MAX_CONCURRENCY,
  selectMultiHostProfilesByTag,
} from '@/lib/multi-host-runbook';
import {
  applyRunbookStepResult,
  isRunbookEvidenceStale,
  markRunbookItemRunning,
  parseRunbookText,
  pauseRunbook,
  prepareRunbook,
  rejectRunbookItem,
  resumeRunbook,
  retryRunbookFrom,
  RUNBOOK_EXAMPLE,
  serializeRunbook,
  skipRunbookItem,
  startRunbookRun,
} from '@/lib/runbook';
import {
  buildRemoteConnectionRequest,
  invokeCancelRunbookStep,
  invokeExecuteRunbookStep,
  invokeOpenRunbookFile,
  invokeSaveRunbookFile,
} from '@/lib/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import type { MultiHostRunbookTask } from '@/types/multi-host-runbook';
import type {
  RunbookDocument,
  RunbookRisk,
  RunbookRun,
  RunbookRunItem,
  RunbookStepExecutionResult,
} from '@/types/runbook';
import { MultiHostRunbookExecution } from './multi-host-runbook-execution';
import { RunbookDestructiveDialog } from './runbook-destructive-dialog';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from './workbench-page';

const RunbookJsonEditor = React.lazy(() => import('./runbook-json-editor'));

type RunbookTargetMode = 'single' | 'tag';

interface RunbookPreviewItem {
  id: string;
  kind: 'precheck' | 'step';
  description: string;
  command: string;
  risk: RunbookRisk;
  timeoutSeconds: number;
  impact?: string;
  rollback?: string;
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

function syntheticResult(
  run: RunbookRun,
  item: RunbookRunItem,
  operationId: string,
  status: RunbookStepExecutionResult['status'],
  error: string,
): RunbookStepExecutionResult {
  const now = Date.now();
  return {
    operationId,
    runId: run.id,
    runbookId: run.runbookId,
    sourceDigest: run.sourceDigest,
    itemId: item.id,
    itemKind: item.kind,
    profileId: run.target.profileId,
    status,
    risk: item.risk,
    commandPreview: item.commandPreview,
    startedAt: now,
    completedAt: now,
    source: {
      kind: 'sshRunbook',
      profileId: run.target.profileId,
      host: run.target.host,
      port: run.target.port,
      username: run.target.username,
    },
    expectedMatched: false,
    error,
  };
}

export const RunbookPanel: React.FC = () => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const profiles = useProfileStore((state) => state.profiles);
  const [sourceText, setSourceText] = useState(() => serializeRunbook(parseRunbookText(RUNBOOK_EXAMPLE)));
  const [sourcePath, setSourcePath] = useState<string>();
  const [document, setDocument] = useState<RunbookDocument>(() => parseRunbookText(RUNBOOK_EXAMPLE));
  const [validatedText, setValidatedText] = useState(() => serializeRunbook(parseRunbookText(RUNBOOK_EXAMPLE)));
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [targetMode, setTargetMode] = useState<RunbookTargetMode>('single');
  const [targetProfileId, setTargetProfileId] = useState<string>();
  const [selectedTag, setSelectedTag] = useState<string>();
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [batchSize, setBatchSize] = useState(5);
  const [run, setRun] = useState<RunbookRun>();
  const [multiHostTask, setMultiHostTask] = useState<MultiHostRunbookTask>();
  const [operationId, setOperationId] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [editorProblemCount, setEditorProblemCount] = useState(0);
  const [aiDraft, setAiDraft] = useState<AiRunbookDraftDetail>();

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === targetProfileId),
    [profiles, targetProfileId],
  );
  const availableTags = useMemo(() => listMultiHostRunbookTags(profiles), [profiles]);
  const multiHostTargets = useMemo(
    () => selectedTag ? selectMultiHostProfilesByTag(profiles, selectedTag) : [],
    [profiles, selectedTag],
  );
  const activeItem = run?.items.find((item) => item.id === run.activeItemId);
  const executionLocked = run?.phase === 'running'
    || Boolean(multiHostTask && !isMultiHostRunbookTaskTerminal(multiHostTask));
  const hasUnvalidatedChanges = sourceText !== validatedText;
  const previewItems = useMemo<RunbookPreviewItem[]>(() => [
    ...document.prechecks.map((item) => ({
      ...item,
      kind: 'precheck' as const,
      risk: 'readOnly' as const,
    })),
    ...document.steps.map((item) => ({
      ...item,
      kind: 'step' as const,
    })),
  ], [document]);
  const highestRisk = useMemo<RunbookRisk>(() => {
    if (document.steps.some((step) => step.risk === 'destructive')) return 'destructive';
    if (document.steps.some((step) => step.risk === 'stateChange')) return 'stateChange';
    return 'readOnly';
  }, [document.steps]);
  const selectedTargetCount = targetMode === 'single'
    ? Number(Boolean(selectedProfile))
    : multiHostTargets.length;

  const recordRunbookTransition = (
    current: RunbookRun,
    item: RunbookRunItem | undefined,
    eventKind: 'started' | 'rejected' | 'paused' | 'resumed' | 'skipped' | 'retryRequested' | 'failed' | 'completed',
    status: 'pending' | 'running' | 'rejected' | 'paused' | 'skipped' | 'failed' | 'cancelled',
    eventOperationId = item?.evidence?.operationId ?? current.id,
  ): void => {
    void recordOperationHistoryTransition({
      taskId: current.id,
      operationId: eventOperationId,
      category: 'runbook',
      action: 'executeRunbookStep',
      eventKind,
      status,
      risk: item?.risk ?? 'readOnly',
      subjectId: item?.id,
      commandPreview: item?.commandPreview,
      targets: [{
        kind: 'remote',
        profileId: current.target.profileId,
        host: current.target.host,
        port: current.target.port,
        username: current.target.username,
      }],
      evidence: current.items.flatMap((entry) => entry.evidence ? [{
        operationId: entry.evidence.operationId,
        kind: 'runbookStep' as const,
        observedAt: entry.evidence.completedAt,
        digest: current.sourceDigest,
      }] : []),
      retryOfOperationId: eventKind === 'retryRequested' ? item?.evidence?.operationId : undefined,
    });
  };

  const applyValidatedText = useCallback((text: string, path?: string): void => {
    const parsed = parseRunbookText(text);
    const normalized = serializeRunbook(parsed);
    setSourceText(normalized);
    setValidatedText(normalized);
    setDocument(parsed);
    setSourcePath(path);
    setVariableValues({});
    setRun(undefined);
    setMultiHostTask(undefined);
    setValidationError(undefined);
    setEditorProblemCount(0);
  }, []);

  useEffect(() => {
    const applyDraft = (detail: AiRunbookDraftDetail): void => {
      applyValidatedText(detail.sourceText);
      setTargetMode('single');
      setTargetProfileId(detail.profileId);
      setAiDraft(detail);
    };
    const pending = consumePendingAgentRunbookDraft();
    if (pending) applyDraft(pending);
    const handleDraft = (event: Event): void => {
      const detail = consumePendingAgentRunbookDraft()
        ?? (event as CustomEvent<AiRunbookDraftDetail>).detail;
      if (detail?.sourceText) applyDraft(detail);
    };
    window.addEventListener(AI_RUNBOOK_DRAFT_EVENT, handleDraft);
    return () => window.removeEventListener(AI_RUNBOOK_DRAFT_EVENT, handleDraft);
  }, [applyValidatedText]);

  const handleValidate = (): void => {
    try {
      applyValidatedText(sourceText, sourcePath);
      showSuccess(t('runbook.valid'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      showError(t('runbook.invalid'));
    }
  };

  const handleOpen = async (): Promise<void> => {
    try {
      const file = await invokeOpenRunbookFile();
      if (file) {
        applyValidatedText(file.text, file.path);
        setAiDraft(undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      showError(t('runbook.openFailed'));
    }
  };

  const handleSave = async (): Promise<void> => {
    try {
      const parsed = parseRunbookText(sourceText);
      const file = await invokeSaveRunbookFile(serializeRunbook(parsed));
      if (file) {
        applyValidatedText(file.text, file.path);
        showSuccess(t('runbook.saved', { path: file.path }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setValidationError(message);
      showError(t('runbook.saveFailed'));
    }
  };

  const handleStart = (): void => {
    if (targetMode === 'tag') {
      if (!selectedTag) {
        setValidationError(t('runbook.multi.tagRequired'));
        return;
      }
      try {
        const task = createMultiHostRunbookTask({
          id: createOperationId('multi-host-task'),
          sourceText,
          variableValues,
          profiles,
          selectedTag,
          concurrencyLimit,
          batchSize,
          createRunId: () => createOperationId('multi-host-run'),
        });
        const parsed = parseRunbookText(task.sourceText);
        setSourceText(task.sourceText);
        setValidatedText(task.sourceText);
        setDocument(parsed);
        setRun(undefined);
        setMultiHostTask(task);
        setValidationError(undefined);
      } catch (error) {
        setValidationError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!selectedProfile) {
      setValidationError(t('runbook.targetRequired'));
      return;
    }
    try {
      const prepared = prepareRunbook(sourceText, variableValues, {
        profileId: selectedProfile.id,
        name: selectedProfile.name,
        host: selectedProfile.host,
        port: selectedProfile.port,
        username: selectedProfile.username,
      });
      setSourceText(prepared.sourceText);
      setValidatedText(prepared.sourceText);
      setDocument(prepared.document);
      setMultiHostTask(undefined);
      const nextRun = startRunbookRun(prepared, createOperationId('runbook-run'));
      setRun(nextRun);
      recordRunbookTransition(
        nextRun,
        nextRun.items.find((item) => item.id === nextRun.activeItemId),
        'started',
        'pending',
      );
      setValidationError(undefined);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const performExecute = async (): Promise<void> => {
    setConfirming(false);
    if (!run || !activeItem || run.phase !== 'awaitingApproval') return;
    const profile = useProfileStore.getState().getProfile(run.target.profileId);
    if (!profile) {
      const failedOperationId = createOperationId('runbook');
      setRun(applyRunbookStepResult(
        markRunbookItemRunning(run),
        syntheticResult(run, activeItem, failedOperationId, 'failed', t('runbook.targetMissing')),
      ));
      recordRunbookTransition(run, activeItem, 'failed', 'failed', failedOperationId);
      return;
    }
    setPreparing(true);
    let profileWithSavedSecrets: ConnectionProfile | undefined;
    try {
      profileWithSavedSecrets = await useProfileStore.getState().ensurePassword(profile);
      const withPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!withPassword) {
        const cancelledOperationId = createOperationId('runbook');
        const cancelled = syntheticResult(
          run,
          activeItem,
          cancelledOperationId,
          'cancelled',
          t('runbook.credentialCancelled'),
        );
        setRun((current) => current
          ? applyRunbookStepResult(markRunbookItemRunning(current), cancelled)
          : current);
        recordRunbookTransition(run, activeItem, 'completed', 'cancelled', cancelledOperationId);
        return;
      }
      const preparedProfile = await ensureKeychainKeyForProfile(withPassword);
      if (!preparedProfile) {
        const cancelledOperationId = createOperationId('runbook');
        const cancelled = syntheticResult(
          run,
          activeItem,
          cancelledOperationId,
          'cancelled',
          t('runbook.credentialCancelled'),
        );
        setRun((current) => current
          ? applyRunbookStepResult(markRunbookItemRunning(current), cancelled)
          : current);
        recordRunbookTransition(run, activeItem, 'completed', 'cancelled', cancelledOperationId);
        return;
      }
      const nextOperationId = createOperationId('runbook');
      const approvedRun = markRunbookItemRunning(run);
      if (approvedRun.phase !== 'running') {
        setRun(approvedRun);
        return;
      }
      setOperationId(nextOperationId);
      setRun(approvedRun);
      const plainValues = Object.fromEntries(document.variables
        .filter((variable) => !variable.keychainRef && variableValues[variable.name] !== undefined)
        .map((variable) => [variable.name, variableValues[variable.name]]));
      const result = await invokeExecuteRunbookStep(
        {
          operationId: nextOperationId,
          runId: run.id,
          sourceDigest: run.sourceDigest,
          runbookText: validatedText,
          itemId: activeItem.id,
          itemKind: activeItem.kind,
          profileId: profile.id,
          authorized: true,
          approvedRisk: activeItem.risk,
          variableValues: plainValues,
          evidenceReferences: run.items.flatMap((item) => item.evidence ? [{
            operationId: item.evidence.operationId,
            kind: 'runbookStep' as const,
            observedAt: item.evidence.completedAt,
            digest: run.sourceDigest,
          }] : []),
          timeoutMs: activeItem.timeoutSeconds * 1000,
          connection: buildRemoteConnectionRequest(preparedProfile),
        },
        { commandPreview: activeItem.commandPreview },
      );
      if (result.status === 'success') {
        await persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
      }
      setRun((current) => current ? applyRunbookStepResult(current, result) : current);
    } catch (error) {
      const failed = syntheticResult(
        run,
        activeItem,
        operationId ?? createOperationId('runbook'),
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      setRun((current) => current
        ? applyRunbookStepResult(
            current.phase === 'running' ? current : markRunbookItemRunning(current),
            failed,
          )
        : current);
    } finally {
      setPreparing(false);
      setOperationId(undefined);
    }
  };

  const handleApprove = (): void => {
    if (activeItem?.risk === 'destructive') {
      setConfirming(true);
    } else {
      void performExecute();
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!operationId) return;
    try {
      await invokeCancelRunbookStep(operationId);
    } catch {
      showError(t('runbook.cancelFailed'));
    }
  };

  const handlePause = (): void => {
    if (!run) return;
    recordRunbookTransition(run, activeItem, 'paused', 'paused');
    setRun(pauseRunbook(run));
  };

  const handleReject = (): void => {
    if (!run) return;
    recordRunbookTransition(run, activeItem, 'rejected', 'rejected');
    setRun(rejectRunbookItem(run));
  };

  const handleSkip = (): void => {
    if (!run) return;
    recordRunbookTransition(run, activeItem, 'skipped', 'skipped');
    setRun(skipRunbookItem(run));
  };

  const handleResume = (): void => {
    if (!run) return;
    recordRunbookTransition(run, activeItem, 'resumed', 'pending');
    setRun(resumeRunbook(run));
  };

  const handleRetry = (item: RunbookRunItem): void => {
    if (!run) return;
    recordRunbookTransition(run, item, 'retryRequested', 'pending');
    setRun(retryRunbookFrom(run, item.id));
  };

  return (
    <WorkbenchPage data-slot="runbook-panel">
      <WorkbenchPageHeader
        icon={ListChecksIcon}
        title={t('runbook.title')}
        titleMeta={(
          <Badge variant={hasUnvalidatedChanges ? 'secondary' : 'outline'}>
            {t(hasUnvalidatedChanges ? 'runbook.status.needsValidation' : 'runbook.status.validated')}
          </Badge>
        )}
        description={(
          <>
            {t('runbook.description')}
            {sourcePath && <span className="font-mono"> · {sourcePath}</span>}
          </>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => void handleOpen()} disabled={executionLocked}>
              {t('runbook.open')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleSave()} disabled={executionLocked}>
              {t('runbook.save')}
            </Button>
            <Button size="sm" onClick={handleValidate} disabled={executionLocked}>
              {t('runbook.validate')}
            </Button>
          </>
        )}
      />

      <ScrollArea className="min-h-0 flex-1">
        <WorkbenchPageContent className="@container">
          {validationError && (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>{t('runbook.validationFailed')}</AlertTitle>
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}

          {aiDraft && (
            <Alert>
              <ShieldAlertIcon />
              <AlertTitle>{t('runbook.aiDraftTitle')}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-1">
                  <span>{t('runbook.aiDraftDescription')}</span>
                  <span>{t('ai.agent.objective')}: {aiDraft.objective}</span>
                  <span>{t('ai.agent.target')}: {aiDraft.target}</span>
                  <span>{t('ai.agent.boundTarget')}: {aiDraft.contextLabel}</span>
                  <span>
                    {t('runbook.aiDraftObservedAt')}: {new Date(aiDraft.contextObservedAt).toLocaleString()}
                  </span>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <Card data-slot="runbook-overview" size="sm">
            <CardHeader>
              <CardTitle>{document.name}</CardTitle>
              <CardDescription>{document.description}</CardDescription>
              <CardAction>
                <Badge variant="outline">{document.id}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 @min-[52rem]:grid-cols-4">
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <WorkflowIcon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t('runbook.overview.workflow')}</p>
                  <p className="font-medium">{t('runbook.overview.itemCount', { count: previewItems.length })}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <BracesIcon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t('runbook.overview.variables')}</p>
                  <p className="font-medium">{document.variables.length}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ShieldAlertIcon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t('runbook.overview.highestRisk')}</p>
                  <Badge variant={riskVariant(highestRisk)}>{t(`runbook.risk.${highestRisk}` as LocaleKey)}</Badge>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Clock3Icon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t('runbook.overview.evidenceWindow')}</p>
                  <p className="font-medium">{document.evidenceMaxAgeSeconds}s</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="gap-2 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-4 shrink-0" aria-hidden />
              <span>{t('runbook.secretPolicy')}</span>
            </CardFooter>
          </Card>

          <div
            data-slot="runbook-layout"
            className="grid min-w-0 grid-cols-1 items-start gap-3 @min-[60rem]:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]"
          >
            <Tabs defaultValue="source" className="min-w-0 gap-0">
              <Card data-slot="runbook-workspace" className="min-w-0">
                <CardHeader>
                  <CardTitle>{t('runbook.workspaceTitle')}</CardTitle>
                  <CardDescription>{t('runbook.workspaceDescription')}</CardDescription>
                  <CardAction className="@max-[34rem]:col-start-1 @max-[34rem]:row-start-3 @max-[34rem]:justify-self-start">
                    <TabsList variant="line">
                      <TabsTrigger value="source">
                        {t('runbook.tab.source')}
                      </TabsTrigger>
                      <TabsTrigger value="workflow">
                        {t('runbook.tab.workflow')}
                      </TabsTrigger>
                    </TabsList>
                  </CardAction>
                </CardHeader>
                <CardContent className="min-h-0">
                  <TabsContent value="source">
                    <React.Suspense
                      fallback={(
                        <div
                          className="flex h-[30rem] items-center justify-center rounded-lg border bg-background"
                          aria-label={t('runbook.editor.loading')}
                          aria-busy="true"
                        >
                          <Spinner />
                        </div>
                      )}
                    >
                      <RunbookJsonEditor
                        ariaLabel={t('runbook.textTitle')}
                        value={sourceText}
                        disabled={executionLocked}
                        onProblemsChange={setEditorProblemCount}
                        onChange={(nextText) => {
                          setSourceText(nextText);
                          setValidationError(undefined);
                          setRun(undefined);
                          setMultiHostTask(undefined);
                        }}
                      />
                    </React.Suspense>
                  </TabsContent>
                  <TabsContent value="workflow">
                    <ol className="flex min-h-[30rem] flex-col">
                      {previewItems.map((item, index) => (
                        <React.Fragment key={`${item.kind}-${item.id}`}>
                          {index > 0 && <Separator />}
                          <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 py-4 first:pt-0 last:pb-0">
                            <div className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                              {index + 1}
                            </div>
                            <div className="flex min-w-0 flex-col gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{item.description}</span>
                                <Badge variant="outline">
                                  {t(item.kind === 'precheck' ? 'runbook.item.precheck' : 'runbook.item.step')}
                                </Badge>
                                <Badge variant={riskVariant(item.risk)}>
                                  {t(`runbook.risk.${item.risk}` as LocaleKey)}
                                </Badge>
                              </div>
                              <code className="break-all rounded-lg bg-muted/60 px-3 py-2 text-foreground">
                                {item.command}
                              </code>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>{t('runbook.timeout')}: {item.timeoutSeconds}s</span>
                                {item.impact && <span>{t('runbook.impact')}: {item.impact}</span>}
                              </div>
                              {item.rollback && (
                                <p className="text-xs text-muted-foreground">
                                  {t('runbook.rollback')}: {item.rollback}
                                </p>
                              )}
                            </div>
                          </li>
                        </React.Fragment>
                      ))}
                    </ol>
                  </TabsContent>
                </CardContent>
                <CardFooter className="flex-col items-start gap-2 @min-[34rem]:flex-row @min-[34rem]:items-center @min-[34rem]:justify-between">
                  <span className="text-xs text-muted-foreground">{t('runbook.textDescription')}</span>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t('runbook.editor.shortcuts')}</span>
                    <Badge
                      variant={editorProblemCount > 0
                        ? 'destructive'
                        : hasUnvalidatedChanges ? 'secondary' : 'outline'}
                    >
                      {editorProblemCount > 0
                        ? t('runbook.editor.problems', { count: editorProblemCount })
                        : hasUnvalidatedChanges
                          ? t('runbook.status.needsValidation')
                          : 'JSON · schema v1'}
                    </Badge>
                  </div>
                </CardFooter>
              </Card>
            </Tabs>

            <Card data-slot="runbook-setup" className="min-w-0 @min-[60rem]:sticky @min-[60rem]:top-4">
              <CardHeader>
                <CardTitle>{t('runbook.setupTitle')}</CardTitle>
                <CardDescription>{t('runbook.setupDescription')}</CardDescription>
                <CardAction>
                  <Badge variant={selectedTargetCount > 0 ? 'secondary' : 'outline'}>
                    {t('runbook.targetsSelected', { count: selectedTargetCount })}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t('runbook.targetMode')}</FieldLabel>
                    <ToggleGroup
                      value={[targetMode]}
                      onValueChange={(next) => {
                        const selected = next[0] as RunbookTargetMode | undefined;
                        if (selected) {
                          setTargetMode(selected);
                          setRun(undefined);
                          setMultiHostTask(undefined);
                          setValidationError(undefined);
                        }
                      }}
                      variant="outline"
                      size="sm"
                      spacing={0}
                      className="w-full"
                      aria-label={t('runbook.targetMode')}
                      disabled={executionLocked}
                    >
                      <ToggleGroupItem value="single" className="flex-1">
                        {t('runbook.targetMode.single')}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="tag" className="flex-1">
                        {t('runbook.targetMode.tag')}
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <FieldDescription>{t('runbook.targetModeDescription')}</FieldDescription>
                  </Field>

                  {targetMode === 'single' ? (
                    <Field>
                      <FieldLabel>{t('runbook.target')}</FieldLabel>
                      <Select
                        value={targetProfileId ?? null}
                        onValueChange={(value) => setTargetProfileId(value ?? undefined)}
                        disabled={executionLocked}
                      >
                        <SelectTrigger aria-label={t('runbook.target')}>
                          <SelectValue placeholder={t('runbook.chooseTarget')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>{t('runbook.profiles')}</SelectLabel>
                            {profiles.map((profile) => (
                              <SelectItem key={profile.id} value={profile.id}>
                                {profile.name} · {profile.username}@{profile.host}:{profile.port}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>{t('runbook.targetDescription')}</FieldDescription>
                    </Field>
                  ) : (
                    <>
                      <Field data-invalid={Boolean(selectedTag && multiHostTargets.length === 0)}>
                        <FieldLabel>{t('runbook.multi.tag')}</FieldLabel>
                        <Select
                          value={selectedTag ?? null}
                          onValueChange={(value) => setSelectedTag(value ?? undefined)}
                          disabled={executionLocked}
                        >
                          <SelectTrigger
                            aria-label={t('runbook.multi.tag')}
                            aria-invalid={Boolean(selectedTag && multiHostTargets.length === 0)}
                          >
                            <SelectValue placeholder={t('runbook.multi.chooseTag')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectLabel>{t('runbook.multi.availableTags')}</SelectLabel>
                              {availableTags.map((tag) => (
                                <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          {t('runbook.multi.targetCount', { count: multiHostTargets.length })}
                        </FieldDescription>
                      </Field>
                      <FieldGroup className="grid grid-cols-1 gap-3 @min-[34rem]:grid-cols-2">
                        <Field data-invalid={concurrencyLimit < 1 || concurrencyLimit > MULTI_HOST_MAX_CONCURRENCY}>
                          <FieldLabel htmlFor="runbook-multi-concurrency">{t('runbook.multi.concurrency')}</FieldLabel>
                          <Input
                            id="runbook-multi-concurrency"
                            type="number"
                            min={1}
                            max={MULTI_HOST_MAX_CONCURRENCY}
                            value={concurrencyLimit}
                            disabled={executionLocked}
                            aria-invalid={concurrencyLimit < 1 || concurrencyLimit > MULTI_HOST_MAX_CONCURRENCY}
                            onChange={(event) => setConcurrencyLimit(Number(event.target.value))}
                          />
                          <FieldDescription>{t('runbook.multi.concurrencyDescription')}</FieldDescription>
                        </Field>
                        <Field data-invalid={batchSize < 1 || batchSize > MULTI_HOST_MAX_BATCH_SIZE || concurrencyLimit > batchSize}>
                          <FieldLabel htmlFor="runbook-multi-batch">{t('runbook.multi.batchSize')}</FieldLabel>
                          <Input
                            id="runbook-multi-batch"
                            type="number"
                            min={1}
                            max={MULTI_HOST_MAX_BATCH_SIZE}
                            value={batchSize}
                            disabled={executionLocked}
                            aria-invalid={batchSize < 1 || batchSize > MULTI_HOST_MAX_BATCH_SIZE || concurrencyLimit > batchSize}
                            onChange={(event) => setBatchSize(Number(event.target.value))}
                          />
                          <FieldDescription>{t('runbook.multi.batchDescription')}</FieldDescription>
                        </Field>
                      </FieldGroup>
                    </>
                  )}
                </FieldGroup>

                {document.variables.length > 0 && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t('runbook.variablesTitle')}</span>
                      <Badge variant="outline">{document.variables.length}</Badge>
                    </div>
                    <FieldGroup>
                      {document.variables.map((variable) => (
                        <Field key={variable.name}>
                          <FieldLabel htmlFor={`runbook-${variable.name}`}>{variable.name}</FieldLabel>
                          {variable.keychainRef ? (
                            <Badge variant="outline">{variable.keychainRef}</Badge>
                          ) : (
                            <Input
                              id={`runbook-${variable.name}`}
                              value={variableValues[variable.name] ?? ''}
                              placeholder={variable.default}
                              disabled={executionLocked}
                              onChange={(event) => setVariableValues((current) => ({
                                ...current,
                                [variable.name]: event.target.value,
                              }))}
                            />
                          )}
                          <FieldDescription>{variable.description}</FieldDescription>
                        </Field>
                      ))}
                    </FieldGroup>
                  </>
                )}
              </CardContent>
              <CardFooter className="flex-col items-stretch gap-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheckIcon className="size-4 shrink-0" aria-hidden />
                  <span>{t('runbook.setupSafety')}</span>
                </div>
                <Button
                  onClick={handleStart}
                  disabled={executionLocked || hasUnvalidatedChanges || (targetMode === 'single' ? !selectedProfile : !selectedTag || multiHostTargets.length === 0)}
                >
                  {t(targetMode === 'single' ? 'runbook.reviewRun' : 'runbook.multi.startPreflight')}
                </Button>
              </CardFooter>
            </Card>
          </div>

          {run && (
            <Card data-slot="runbook-execution-review">
              <CardHeader>
                <CardTitle>{t('runbook.executionReview')}</CardTitle>
                <CardDescription>
                  {run.target.name} · {run.target.username}@{run.target.host}:{run.target.port}
                </CardDescription>
                <CardAction>
                  <Badge variant={run.phase === 'completed' ? 'default' : 'secondary'}>
                    {t(`runbook.phase.${run.phase}` as LocaleKey)}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {Object.keys(run.resolvedVariables).length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('runbook.resolvedVariables')}</span>
                    <div className="grid grid-cols-1 gap-2 @min-[42rem]:grid-cols-2">
                      {Object.entries(run.resolvedVariables).map(([name, value]) => (
                        <div key={name} className="grid grid-cols-[8rem_1fr] gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs">
                          <span>{name}</span>
                          <code className="break-all">{value}</code>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeItem && (
                  <Alert variant={activeItem.risk === 'destructive' ? 'destructive' : 'default'}>
                    <ShieldAlertIcon />
                    <AlertTitle className="flex items-center gap-2">
                      {activeItem.description}
                      <Badge variant={riskVariant(activeItem.risk)}>{t(`runbook.risk.${activeItem.risk}` as LocaleKey)}</Badge>
                    </AlertTitle>
                    <AlertDescription>
                      <div className="flex flex-col gap-2">
                        <span>{t('runbook.impact')}: {activeItem.impact}</span>
                        {activeItem.rollback && (
                          <span>{t('runbook.rollback')}: {activeItem.rollback}</span>
                        )}
                        <code className="break-all rounded-md bg-muted p-2 text-foreground">{activeItem.commandPreview}</code>
                        <span>{t('runbook.timeout')}: {activeItem.timeoutSeconds}s</span>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                <ol className="flex flex-col gap-2">
                  {run.items.map((item, index) => {
                    const stale = item.kind === 'precheck'
                      && item.status === 'completed'
                      && isRunbookEvidenceStale(item.evidence, run.evidenceMaxAgeSeconds);
                    return (
                      <li key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg bg-muted/40 p-3 ring-1 ring-foreground/10">
                        <div className="flex size-7 items-center justify-center rounded-full bg-background text-xs font-medium">
                          {index + 1}
                        </div>
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.description}</span>
                            <Badge variant={riskVariant(item.risk)}>{t(`runbook.risk.${item.risk}` as LocaleKey)}</Badge>
                          </div>
                          <code className="break-all text-xs text-muted-foreground">{item.commandPreview}</code>
                          {(item.evidence || item.error) && (
                            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
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
                              {item.evidence?.stdout && <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stdout}</code>}
                              {item.evidence?.stderr && <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stderr}</code>}
                              {item.error && <span className="text-destructive">{item.error}</span>}
                            </div>
                          )}
                          {item.safeToRetry && ['stopped', 'cancelled', 'staleEvidence'].includes(run.phase) && (
                            <div>
                              <Button size="xs" variant="outline" onClick={() => handleRetry(item)}>
                                {t('runbook.retryFrom')}
                              </Button>
                            </div>
                          )}
                        </div>
                        <Badge variant={stale ? 'destructive' : itemStatusVariant(item.status)}>
                          {stale ? t('runbook.evidenceStale') : t(`runbook.status.${item.status}` as LocaleKey)}
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
              </CardContent>
              <CardFooter className="flex-col gap-2 @min-[36rem]:flex-row @min-[36rem]:justify-between">
                <div className="flex flex-wrap gap-2">
                  {run.phase === 'awaitingApproval' && (
                    <>
                      <Button size="sm" variant="outline" onClick={handlePause}>{t('runbook.pause')}</Button>
                      <Button size="sm" variant="outline" onClick={handleReject}>{t('runbook.reject')}</Button>
                      {activeItem?.kind === 'step' && (
                        <Button size="sm" variant="outline" onClick={handleSkip}>{t('runbook.skip')}</Button>
                      )}
                    </>
                  )}
                  {run.phase === 'paused' && (
                    <Button size="sm" variant="outline" onClick={handleResume}>{t('runbook.resume')}</Button>
                  )}
                  {run.phase === 'running' && (
                    <Button size="sm" variant="destructive" onClick={() => void handleCancel()} disabled={!operationId}>
                      {t('runbook.cancel')}
                    </Button>
                  )}
                </div>
                {run.phase === 'awaitingApproval' && (
                  <Button
                    size="sm"
                    variant={activeItem?.risk === 'destructive' ? 'destructive' : 'default'}
                    onClick={handleApprove}
                    disabled={preparing}
                  >
                    {preparing && <Spinner data-icon="inline-start" />}
                    {t('runbook.approveExecute')}
                  </Button>
                )}
              </CardFooter>
            </Card>
          )}

          {multiHostTask && (
            <MultiHostRunbookExecution
              key={multiHostTask.id}
              initialTask={multiHostTask}
              profiles={profiles}
              onTaskChange={setMultiHostTask}
            />
          )}

          <RunbookDestructiveDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t('runbook.destructiveTitle')}
            description={t('runbook.destructiveDescription')}
            target={run?.target}
            item={activeItem}
            onConfirm={() => void performExecute()}
          />
        </WorkbenchPageContent>
      </ScrollArea>
    </WorkbenchPage>
  );
};
