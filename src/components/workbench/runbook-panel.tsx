import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  FileInputIcon,
  FileOutputIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SkipForwardIcon,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/empty-state';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { LocaleKey } from '@/locales';
import { ensureKeychainKeyForProfile } from '@/lib/keychain-key-prompt';
import { createOperationId } from '@/lib/operation-id';
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

type RunbookTargetMode = 'single' | 'tag';

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
  const [sourceText, setSourceText] = useState(RUNBOOK_EXAMPLE);
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
      setRun(startRunbookRun(prepared, createOperationId('runbook-run')));
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
      setRun(applyRunbookStepResult(
        markRunbookItemRunning(run),
        syntheticResult(run, activeItem, createOperationId('runbook'), 'failed', t('runbook.targetMissing')),
      ));
      return;
    }
    setPreparing(true);
    let profileWithSavedSecrets: ConnectionProfile | undefined;
    try {
      profileWithSavedSecrets = await useProfileStore.getState().ensurePassword(profile);
      const withPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!withPassword) {
        const cancelled = syntheticResult(
          run,
          activeItem,
          createOperationId('runbook'),
          'cancelled',
          t('runbook.credentialCancelled'),
        );
        setRun((current) => current
          ? applyRunbookStepResult(markRunbookItemRunning(current), cancelled)
          : current);
        return;
      }
      const preparedProfile = await ensureKeychainKeyForProfile(withPassword);
      if (!preparedProfile) {
        const cancelled = syntheticResult(
          run,
          activeItem,
          createOperationId('runbook'),
          'cancelled',
          t('runbook.credentialCancelled'),
        );
        setRun((current) => current
          ? applyRunbookStepResult(markRunbookItemRunning(current), cancelled)
          : current);
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
      const result = await invokeExecuteRunbookStep({
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
        timeoutMs: activeItem.timeoutSeconds * 1000,
        connection: buildRemoteConnectionRequest(preparedProfile),
      });
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold">{t('runbook.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('runbook.description')}</p>
          {sourcePath && <p className="text-xs text-muted-foreground">{sourcePath}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleOpen()} disabled={executionLocked}>
            <FileInputIcon data-icon="inline-start" />
            {t('runbook.open')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleSave()} disabled={executionLocked}>
            <FileOutputIcon data-icon="inline-start" />
            {t('runbook.save')}
          </Button>
          <Button size="sm" onClick={handleValidate} disabled={executionLocked}>
            <CheckCircle2Icon data-icon="inline-start" />
            {t('runbook.validate')}
          </Button>
        </div>
      </div>

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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(22rem,0.8fr)_minmax(30rem,1.2fr)] gap-3">
        <Card className="min-h-0">
          <CardHeader>
            <CardTitle>{t('runbook.textTitle')}</CardTitle>
            <CardDescription>{t('runbook.textDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            <Textarea
              aria-label={t('runbook.textTitle')}
              className="h-full min-h-80 resize-none"
              value={sourceText}
              disabled={executionLocked}
              onChange={(event) => {
                setSourceText(event.target.value);
                setValidationError(undefined);
                setRun(undefined);
                setMultiHostTask(undefined);
              }}
              spellCheck={false}
            />
          </CardContent>
          <CardFooter className="justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t('runbook.secretPolicy')}</span>
            <Badge variant="outline">JSON · schema v1</Badge>
          </CardFooter>
        </Card>

        <ScrollArea className="min-h-0">
          <div className="flex flex-col gap-3 pr-2">
            <Card>
              <CardHeader>
                <CardTitle>{document.name}</CardTitle>
                <CardDescription>{document.description}</CardDescription>
                <CardAction>
                  <Badge variant="outline">{document.id}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
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
                      <FieldGroup className="grid grid-cols-2 gap-3">
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
              </CardContent>
              <CardFooter className="justify-end">
                <Button
                  onClick={handleStart}
                  disabled={executionLocked || (targetMode === 'single' ? !selectedProfile : !selectedTag || multiHostTargets.length === 0)}
                >
                  <PlayIcon data-icon="inline-start" />
                  {t(targetMode === 'single' ? 'runbook.reviewRun' : 'runbook.multi.startPreflight')}
                </Button>
              </CardFooter>
            </Card>

            {run && (
              <Card>
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
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('runbook.resolvedVariables')}</span>
                    {Object.entries(run.resolvedVariables).map(([name, value]) => (
                      <div key={name} className="grid grid-cols-[8rem_1fr] gap-2 text-xs">
                        <span>{name}</span>
                        <code className="break-all">{value}</code>
                      </div>
                    ))}
                  </div>

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

                  <div className="flex flex-col gap-2">
                    {run.items.map((item) => {
                      const stale = item.kind === 'precheck'
                        && item.status === 'completed'
                        && isRunbookEvidenceStale(item.evidence, run.evidenceMaxAgeSeconds);
                      return (
                        <Card key={item.id} size="sm">
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                              {item.description}
                              <Badge variant={riskVariant(item.risk)}>{t(`runbook.risk.${item.risk}` as LocaleKey)}</Badge>
                            </CardTitle>
                            <CardDescription>{item.commandPreview}</CardDescription>
                            <CardAction>
                              <Badge variant={stale ? 'destructive' : itemStatusVariant(item.status)}>
                                {stale ? t('runbook.evidenceStale') : t(`runbook.status.${item.status}` as LocaleKey)}
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
                              {item.evidence?.stdout && <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stdout}</code>}
                              {item.evidence?.stderr && <code className="max-h-32 overflow-auto whitespace-pre-wrap">{item.evidence.stderr}</code>}
                              {item.error && <span className="text-destructive">{item.error}</span>}
                            </CardContent>
                          )}
                          {item.safeToRetry && ['stopped', 'cancelled', 'staleEvidence'].includes(run.phase) && (
                            <CardFooter className="justify-end">
                              <Button size="xs" variant="outline" onClick={() => setRun(retryRunbookFrom(run, item.id))}>
                                <RotateCcwIcon data-icon="inline-start" />
                                {t('runbook.retryFrom')}
                              </Button>
                            </CardFooter>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                </CardContent>
                <CardFooter className="justify-between gap-2">
                  <div className="flex gap-2">
                    {run.phase === 'awaitingApproval' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setRun(pauseRunbook(run))}>
                          <PauseIcon data-icon="inline-start" />
                          {t('runbook.pause')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRun(rejectRunbookItem(run))}>
                          <CircleStopIcon data-icon="inline-start" />
                          {t('runbook.reject')}
                        </Button>
                        {activeItem?.kind === 'step' && (
                          <Button size="sm" variant="outline" onClick={() => setRun(skipRunbookItem(run))}>
                            <SkipForwardIcon data-icon="inline-start" />
                            {t('runbook.skip')}
                          </Button>
                        )}
                      </>
                    )}
                    {run.phase === 'paused' && (
                      <Button size="sm" variant="outline" onClick={() => setRun(resumeRunbook(run))}>
                        <PlayIcon data-icon="inline-start" />
                        {t('runbook.resume')}
                      </Button>
                    )}
                    {run.phase === 'running' && (
                      <Button size="sm" variant="destructive" onClick={() => void handleCancel()} disabled={!operationId}>
                        <CircleStopIcon data-icon="inline-start" />
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
                      {preparing ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
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
          </div>
        </ScrollArea>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('runbook.destructiveTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('runbook.destructiveDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {activeItem && (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>{activeItem.impact}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  {activeItem.rollback && (
                    <span>{t('runbook.rollback')}: {activeItem.rollback}</span>
                  )}
                  <code className="break-all">{activeItem.commandPreview}</code>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void performExecute()}>{t('runbook.confirmDestructive')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
