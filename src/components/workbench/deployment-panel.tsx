import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BracesIcon,
  FileDownIcon,
  FileUpIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SquareIcon,
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { ensureKeychainKeyForProfile } from '@/lib/keychain-key-prompt';
import { createOperationId } from '@/lib/operation-id';
import { persistPromptedPassword, promptForMissingPassword } from '@/lib/password-prompt';
import { parseDeploymentRunbookV2Text, serializeDeploymentRunbookV2 } from '@/lib/deployment-runbook';
import { createDeploymentExecutionApproval } from '@/lib/deployment-execution';
import { createRollbackExecutionApproval } from '@/lib/rollback-execution';
import { createDeploymentRolloutBatchApproval } from '@/lib/deployment-rollout';
import {
  createDeploymentTemplate,
  createImportedDeploymentDraft,
  deploymentWorkflowReviewExpired,
  editDeploymentWorkflowDraft,
  freezeDeploymentWorkflowReview,
  validateDeploymentWorkflowDraft,
  type DeploymentTemplateId,
  type DeploymentWorkflowDraft,
  type DeploymentWorkflowState,
} from '@/lib/deployment-workflow';
import {
  buildRemoteConnectionRequest,
  invokeApproveNextDeploymentRolloutBatch,
  invokeCancelDeployment,
  invokeCancelDeploymentRollout,
  invokeExecuteDeployment,
  invokeExecuteRollback,
  invokeGetDeploymentOperation,
  invokeGetDeploymentRollout,
  invokeListDeploymentOperations,
  invokeListDeploymentRollouts,
  invokeOpenRunbookFile,
  invokeRecoverDeploymentRollout,
  invokeReviewDeploymentExecution,
  invokeReviewDeploymentRollout,
  invokeReviewRollbackExecution,
  invokeSaveRunbookFile,
  invokeStartDeploymentRollout,
} from '@/lib/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import type {
  DeploymentExecutionResultV2,
  DeploymentFrozenTargetIdentityV2,
  DeploymentOperationSummaryV2,
  RollbackExecutionResultV2,
  RollbackExecutionReviewV2,
} from '@/types/deployment-runbook';
import type {
  DeploymentRolloutDetailV2,
  DeploymentRolloutReviewV2,
  DeploymentRolloutSummaryV2,
} from '@/types/deployment-rollout';
import type { LocaleKey } from '@/locales';
import { DeploymentApprovalDialog, type DeploymentApprovalFact } from './deployment-approval-dialog';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader } from './workbench-page';

type BusyAction = 'loading' | 'import' | 'export' | 'review' | 'execute' | 'cancel' | 'rollbackReview' | 'rollbackExecute';

type ApprovalIntent =
  | { kind: 'single' }
  | { kind: 'batch'; batchIndex: number; start: boolean }
  | { kind: 'rollback'; review: RollbackExecutionReviewV2 };

interface PreparedProfiles {
  originals: ConnectionProfile[];
  prepared: ConnectionProfile[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function riskVariant(risk: string): 'outline' | 'secondary' | 'destructive' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'stateChange') return 'secondary';
  return 'outline';
}

function phaseVariant(phase: string): 'default' | 'outline' | 'secondary' | 'destructive' {
  if (['succeeded', 'completed'].includes(phase)) return 'default';
  if (['failed', 'cancelled', 'timedOut', 'identityMismatch', 'unauthorized', 'interrupted'].includes(phase)) {
    return 'destructive';
  }
  if (['running', 'verifying', 'awaitingBatchApproval', 'awaitingCanaryApproval'].includes(phase)) {
    return 'secondary';
  }
  return 'outline';
}

function profileMatchesFrozenTarget(
  profile: ConnectionProfile | undefined,
  target: DeploymentFrozenTargetIdentityV2,
): boolean {
  if (!profile
    || profile.id !== target.profileId
    || profile.host !== target.host
    || profile.port !== target.port
    || profile.username !== target.username
    || profile.authMethod !== target.authMethod) return false;
  if (!profile.jumpHost && !target.jumpHost) return true;
  return Boolean(profile.jumpHost && target.jumpHost
    && profile.jumpHost.host === target.jumpHost.host
    && profile.jumpHost.port === target.jumpHost.port
    && profile.jumpHost.username === target.jumpHost.username
    && profile.jumpHost.authMethod === target.jumpHost.authMethod);
}

function selectedBatchIndex(review: DeploymentRolloutReviewV2, detail?: DeploymentRolloutDetailV2): number | undefined {
  if (detail?.reviewId === review.reviewId && detail.currentBatchIndex !== undefined) {
    return detail.currentBatchIndex;
  }
  return review.batches.find((batch) => batch.targetIndexes.some((targetIndex) => (
    review.targets[targetIndex]?.deploymentReview !== undefined
  )))?.batchIndex;
}

export const DeploymentPanel: React.FC = () => {
  const { locale, t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const profiles = useProfileStore((state) => state.profiles);
  const [workflow, setWorkflow] = useState<DeploymentWorkflowState>(() => ({
    draft: createDeploymentTemplate('singleSystemdWeb'),
  }));
  const [busy, setBusy] = useState<BusyAction>();
  const [backendStatus, setBackendStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [error, setError] = useState<string>();
  const [sourcePath, setSourcePath] = useState<string>();
  const [jsonOpen, setJsonOpen] = useState(false);
  const [approvalIntent, setApprovalIntent] = useState<ApprovalIntent>();
  const [singleResult, setSingleResult] = useState<DeploymentExecutionResultV2>();
  const [rolloutDetail, setRolloutDetail] = useState<DeploymentRolloutDetailV2>();
  const [rollbackResult, setRollbackResult] = useState<RollbackExecutionResultV2>();
  const [recoverableRollouts, setRecoverableRollouts] = useState<DeploymentRolloutSummaryV2[]>([]);
  const [recoverableOperations, setRecoverableOperations] = useState<DeploymentOperationSummaryV2[]>([]);
  const [recoverySource, setRecoverySource] = useState<DeploymentRolloutDetailV2>();
  const [now, setNow] = useState(() => Date.now());

  const validation = useMemo(() => validateDeploymentWorkflowDraft(workflow.draft), [workflow.draft]);
  const selectedProfiles = useMemo(() => workflow.draft.targetProfileIds.map((id) => (
    profiles.find((profile) => profile.id === id)
  )), [profiles, workflow.draft.targetProfileIds]);
  const missingTargetIds = workflow.draft.targetProfileIds.filter((id) => !profiles.some((profile) => profile.id === id));
  const duplicateHostIdentity = useMemo(() => {
    const identities = new Set<string>();
    return selectedProfiles.some((profile) => {
      if (!profile) return false;
      const identity = `${profile.host}\u0000${profile.port}\u0000${profile.username}`;
      if (identities.has(identity)) return true;
      identities.add(identity);
      return false;
    });
  }, [selectedProfiles]);
  const frozen = Boolean(workflow.frozenReview);
  const draftLocked = frozen || Boolean(recoverySource) || Boolean(busy && busy !== 'loading');
  const reviewExpired = deploymentWorkflowReviewExpired(workflow, now);

  useEffect(() => {
    if (!workflow.frozenReview) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [workflow.frozenReview]);

  const loadAuthoritativeState = useCallback(async (): Promise<void> => {
    setBusy('loading');
    try {
      const [rollouts, operations] = await Promise.all([
        invokeListDeploymentRollouts({ recoveryRequired: true, limit: 100 }),
        invokeListDeploymentOperations({ recoveryRequired: true, limit: 100 }),
      ]);
      setRecoverableRollouts(rollouts);
      setRecoverableOperations(operations);
      setBackendStatus('available');
      setError(undefined);
    } catch (loadError) {
      setBackendStatus('unavailable');
      setError(errorMessage(loadError));
    } finally {
      setBusy(undefined);
    }
  }, []);

  useEffect(() => {
    void loadAuthoritativeState();
  }, [loadAuthoritativeState]);

  const resetExecutionState = (): void => {
    setSingleResult(undefined);
    setRolloutDetail(undefined);
    setRollbackResult(undefined);
    setApprovalIntent(undefined);
    setError(undefined);
  };

  const replaceDraft = (draft: DeploymentWorkflowDraft): void => {
    setWorkflow({ draft });
    setRecoverySource(undefined);
    resetExecutionState();
  };

  const editDraft = (edit: (draft: DeploymentWorkflowDraft) => DeploymentWorkflowDraft): void => {
    if (draftLocked) return;
    setWorkflow((current) => editDeploymentWorkflowDraft(current, edit));
    resetExecutionState();
  };

  const editDocument = (edit: (document: DeploymentWorkflowDraft['document']) => void): void => {
    editDraft((draft) => {
      const document = JSON.parse(JSON.stringify(draft.document)) as DeploymentWorkflowDraft['document'];
      edit(document);
      return { ...draft, document };
    });
  };

  const prepareProfiles = async (profileIds: readonly string[]): Promise<PreparedProfiles> => {
    const originals: ConnectionProfile[] = [];
    const prepared: ConnectionProfile[] = [];
    for (const profileId of profileIds) {
      const original = useProfileStore.getState().getProfile(profileId);
      if (!original) throw new Error(t('deployment.error.targetMissing', { profileId }));
      const withSavedSecret = await useProfileStore.getState().ensurePassword(original);
      const withPassword = await promptForMissingPassword(withSavedSecret);
      if (!withPassword) throw new Error(t('deployment.error.credentialCancelled'));
      const withKey = await ensureKeychainKeyForProfile(withPassword);
      if (!withKey) throw new Error(t('deployment.error.credentialCancelled'));
      originals.push(original);
      prepared.push(withKey);
    }
    return { originals, prepared };
  };

  const persistPreparedPasswords = async ({ originals, prepared }: PreparedProfiles): Promise<void> => {
    await Promise.all(prepared.map((profile, index) => persistPromptedPassword(originals[index]!, profile)));
  };

  const handleImport = async (): Promise<void> => {
    if (draftLocked) return;
    setBusy('import');
    try {
      const file = await invokeOpenRunbookFile();
      if (!file) return;
      const document = parseDeploymentRunbookV2Text(file.text);
      replaceDraft(createImportedDeploymentDraft(document));
      setSourcePath(file.path);
      showSuccess(t('deployment.imported'));
    } catch (importError) {
      setError(errorMessage(importError));
      showError(t('deployment.importFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const handleExport = async (): Promise<void> => {
    if (!validation.normalizedText) return;
    setBusy('export');
    try {
      const file = await invokeSaveRunbookFile(validation.normalizedText);
      if (file) {
        setSourcePath(file.path);
        showSuccess(t('deployment.exported', { path: file.path }));
      }
    } catch (exportError) {
      setError(errorMessage(exportError));
      showError(t('deployment.exportFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const handleReview = async (): Promise<void> => {
    const { draft } = workflow;
    if (backendStatus !== 'available'
      || validation.errors.length > 0
      || missingTargetIds.length > 0
      || duplicateHostIdentity) return;
    setBusy('review');
    setError(undefined);
    try {
      const preparedProfiles = await prepareProfiles(draft.targetProfileIds);
      const runbookText = validation.normalizedText!;
      if (draft.mode === 'single') {
        const profile = preparedProfiles.prepared[0]!;
        const review = await invokeReviewDeploymentExecution({
          operationId: createOperationId('deployment'),
          runbookText,
          profileId: profile.id,
          connection: buildRemoteConnectionRequest(profile),
          policy: draft.deploymentPolicy,
        });
        setWorkflow((current) => freezeDeploymentWorkflowReview(current, review));
      } else {
        const targets = preparedProfiles.prepared.map((profile) => ({
          profileId: profile.id,
          environment: draft.document.deployment.environment,
          connection: buildRemoteConnectionRequest(profile),
        }));
        const request = {
          rolloutId: recoverySource?.rolloutId ?? createOperationId('deployment-rollout'),
          runbookText,
          profileIds: [...draft.targetProfileIds],
          targets,
          policy: draft.rolloutPolicy,
          deploymentPolicy: draft.deploymentPolicy,
        };
        const review = recoverySource
          ? await invokeRecoverDeploymentRollout({ ...request, sourceReviewId: recoverySource.reviewId })
          : await invokeReviewDeploymentRollout(request);
        setWorkflow((current) => freezeDeploymentWorkflowReview(current, review));
      }
      showSuccess(t('deployment.reviewReady'));
    } catch (reviewError) {
      setError(errorMessage(reviewError));
      showError(t('deployment.reviewFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const frozenTargetDrift = useMemo(() => {
    const frozenReview = workflow.frozenReview;
    if (!frozenReview) return false;
    if (frozenReview.kind === 'single') {
      return !profileMatchesFrozenTarget(
        profiles.find((profile) => profile.id === frozenReview.review.target.profileId),
        frozenReview.review.target,
      );
    }
    return frozenReview.review.targets.some((target) => !profileMatchesFrozenTarget(
      profiles.find((profile) => profile.id === target.profileId),
      target.target,
    ));
  }, [profiles, workflow.frozenReview]);

  const refreshRolloutAfterFailure = async (review: DeploymentRolloutReviewV2): Promise<void> => {
    try {
      const detail = await invokeGetDeploymentRollout(review.rolloutId);
      if (detail) setRolloutDetail(detail);
    } catch {
      // Preserve the original fail-closed error. A missing refresh never enables another action.
    }
  };

  const performSingleExecution = async (): Promise<void> => {
    if (workflow.frozenReview?.kind !== 'single' || reviewExpired || frozenTargetDrift) return;
    const review = workflow.frozenReview.review;
    setBusy('execute');
    try {
      const preparedProfiles = await prepareProfiles([review.target.profileId]);
      const profile = preparedProfiles.prepared[0]!;
      const result = await invokeExecuteDeployment({
        operationId: review.operationId,
        runbookText: review.normalizedRunbookText,
        profileId: review.target.profileId,
        connection: buildRemoteConnectionRequest(profile),
        approval: createDeploymentExecutionApproval(review, {
          authorized: true,
          destructiveConfirmed: review.declaredRisk === 'destructive',
        }),
      }, review);
      setSingleResult(result);
      if (result.phase === 'succeeded') await persistPreparedPasswords(preparedProfiles);
      setApprovalIntent(undefined);
    } catch (executeError) {
      setError(errorMessage(executeError));
      showError(t('deployment.executionFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const performBatchExecution = async (intent: Extract<ApprovalIntent, { kind: 'batch' }>): Promise<void> => {
    if (workflow.frozenReview?.kind !== 'rollout' || reviewExpired || frozenTargetDrift) return;
    const review = workflow.frozenReview.review;
    const batch = review.batches[intent.batchIndex];
    if (!batch) return;
    const profileIds = batch.targetIndexes.flatMap((targetIndex) => (
      review.targets[targetIndex]?.deploymentReview ? [review.targets[targetIndex]!.profileId] : []
    ));
    setBusy('execute');
    try {
      const preparedProfiles = await prepareProfiles(profileIds);
      const batchApproval = createDeploymentRolloutBatchApproval(review, intent.batchIndex, {
        authorized: true,
        destructiveConfirmed: review.declaredRisk === 'destructive',
      });
      const request = {
        rolloutId: review.rolloutId,
        reviewId: review.reviewId,
        planDigest: review.planDigest,
        batchApproval,
        connections: preparedProfiles.prepared.map((profile) => ({
          profileId: profile.id,
          connection: buildRemoteConnectionRequest(profile),
        })),
      };
      const result = intent.start
        ? await invokeStartDeploymentRollout(request, review)
        : await invokeApproveNextDeploymentRolloutBatch(request, review);
      setRolloutDetail(result.detail);
      if (result.targetResults.some((target) => target.phase === 'succeeded')) {
        await persistPreparedPasswords(preparedProfiles);
      }
      setApprovalIntent(undefined);
      await loadAuthoritativeState();
    } catch (executeError) {
      setError(errorMessage(executeError));
      await refreshRolloutAfterFailure(review);
      showError(t('deployment.executionFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const performRollback = async (review: RollbackExecutionReviewV2): Promise<void> => {
    if (review.expiresAt <= Date.now()) return;
    setBusy('rollbackExecute');
    try {
      const preparedProfiles = await prepareProfiles([review.target.profileId]);
      const profile = preparedProfiles.prepared[0]!;
      const result = await invokeExecuteRollback({
        operationId: review.operationId,
        profileId: review.target.profileId,
        connection: buildRemoteConnectionRequest(profile),
        approval: createRollbackExecutionApproval(review, {
          authorized: true,
          destructiveConfirmed: review.declaredRisk === 'destructive',
        }),
      }, review);
      setRollbackResult(result);
      if (result.phase === 'succeeded') await persistPreparedPasswords(preparedProfiles);
      setApprovalIntent(undefined);
      await loadAuthoritativeState();
    } catch (rollbackError) {
      setError(errorMessage(rollbackError));
      showError(t('deployment.rollback.failed'));
    } finally {
      setBusy(undefined);
    }
  };

  const handleApprovalConfirm = (): void => {
    if (!approvalIntent) return;
    const intent = approvalIntent;
    setApprovalIntent(undefined);
    if (intent.kind === 'single') void performSingleExecution();
    else if (intent.kind === 'batch') void performBatchExecution(intent);
    else void performRollback(intent.review);
  };

  const handleCancel = async (): Promise<void> => {
    const frozenReview = workflow.frozenReview;
    if (!frozenReview || busy !== 'execute') return;
    setBusy('cancel');
    try {
      if (frozenReview.kind === 'single') {
        await invokeCancelDeployment(frozenReview.review.operationId);
      } else {
        await invokeCancelDeploymentRollout({
          rolloutId: frozenReview.review.rolloutId,
          reviewId: frozenReview.review.reviewId,
          planDigest: frozenReview.review.planDigest,
        });
      }
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    } finally {
      setBusy('execute');
    }
  };

  const reviewRollback = async (profileId: string, sourceOperationId: string): Promise<void> => {
    setBusy('rollbackReview');
    setError(undefined);
    try {
      const preparedProfiles = await prepareProfiles([profileId]);
      const profile = preparedProfiles.prepared[0]!;
      const review = await invokeReviewRollbackExecution({
        operationId: createOperationId('deployment-rollback'),
        sourceOperationId,
        profileId,
        connection: buildRemoteConnectionRequest(profile),
        totalTimeoutSeconds: 600,
      });
      setApprovalIntent({ kind: 'rollback', review });
    } catch (rollbackError) {
      setError(errorMessage(rollbackError));
      showError(t('deployment.rollback.reviewFailed'));
    } finally {
      setBusy(undefined);
    }
  };

  const loadRecoveryRollout = async (summary: DeploymentRolloutSummaryV2): Promise<void> => {
    setBusy('loading');
    try {
      const detail = await invokeGetDeploymentRollout(summary.rolloutId);
      if (!detail) throw new Error(t('deployment.recovery.notFound'));
      const document = parseDeploymentRunbookV2Text(detail.review.normalizedRunbookText);
      const draft = {
        ...createImportedDeploymentDraft(document),
        mode: 'rollout' as const,
        targetProfileIds: [...detail.review.profileIds],
        rolloutPolicy: detail.review.policy,
        deploymentPolicy: detail.review.deploymentPolicy,
      };
      setWorkflow({ draft });
      setRecoverySource(detail);
      setRolloutDetail(detail);
      setSingleResult(undefined);
      setRollbackResult(undefined);
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setBusy(undefined);
    }
  };

  const loadRecoveryOperation = async (summary: DeploymentOperationSummaryV2): Promise<void> => {
    setBusy('loading');
    try {
      const detail = await invokeGetDeploymentOperation(summary.operationId);
      const review = detail?.review as Partial<{ normalizedRunbookText: string; target: { profileId: string } }> | undefined;
      if (!review?.normalizedRunbookText || !review.target?.profileId) {
        throw new Error(t('deployment.recovery.documentUnavailable'));
      }
      const draft = createImportedDeploymentDraft(parseDeploymentRunbookV2Text(review.normalizedRunbookText));
      draft.targetProfileIds = [review.target.profileId];
      replaceDraft(draft);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setBusy(undefined);
    }
  };

  const reviewRecoveryOperationRollback = async (
    summary: DeploymentOperationSummaryV2,
  ): Promise<void> => {
    setBusy('loading');
    try {
      const detail = await invokeGetDeploymentOperation(summary.operationId);
      const review = detail?.review as Partial<{ target: { profileId: string } }> | undefined;
      if (!review?.target?.profileId) throw new Error(t('deployment.recovery.targetUnavailable'));
      setBusy(undefined);
      await reviewRollback(review.target.profileId, summary.operationId);
    } catch (loadError) {
      setError(errorMessage(loadError));
      setBusy(undefined);
    }
  };

  const updateDeploymentId = (value: string): void => {
    editDocument((document) => {
      document.deployment.id = value;
      const segments = document.release.releaseDirectory.split('/');
      segments[segments.length - 1] = value;
      document.release.releaseDirectory = segments.join('/');
    });
  };

  const updateRootDirectory = (value: string): void => {
    editDocument((document) => {
      document.release.rootDirectory = value;
      document.release.releasesDirectory = `${value}/releases`;
      document.release.releaseDirectory = `${value}/releases/${document.deployment.id}`;
      document.release.activeSymlink = `${value}/current`;
    });
  };

  const selectedTemplate = workflow.draft.templateId;
  const document = workflow.draft.document;
  const firstArtifact = document.artifacts[0];
  const firstService = document.services[0];
  const firstServiceAction = document.serviceActions[0];
  const httpCheck = document.verification.checks.find((check) => check.kind === 'http');
  const normalizedJson = workflow.frozenReview?.review.normalizedRunbookText
    ?? validation.normalizedText
    ?? JSON.stringify(document, null, 2);

  const rolloutReview = workflow.frozenReview?.kind === 'rollout'
    ? workflow.frozenReview.review
    : undefined;
  const batchIndex = rolloutReview ? selectedBatchIndex(rolloutReview, rolloutDetail) : undefined;
  const currentBatch = batchIndex === undefined ? undefined : rolloutReview?.batches[batchIndex];
  const batchIsStart = Boolean(rolloutReview && rolloutDetail?.reviewId !== rolloutReview.reviewId);
  const canApprove = frozen && !reviewExpired && !frozenTargetDrift && !singleResult
    && (!rolloutDetail || ['awaitingBatchApproval', 'awaitingCanaryApproval', 'recoveryRequired'].includes(rolloutDetail.phase));

  const approvalFacts = useMemo<DeploymentApprovalFact[]>(() => {
    if (!approvalIntent) return [];
    if (approvalIntent.kind === 'rollback') {
      const review = approvalIntent.review;
      return [
        { label: t('deployment.environment'), value: review.environment },
        { label: t('deployment.target'), value: `${review.target.username}@${review.target.host}:${review.target.port}` },
        { label: t('deployment.version'), value: review.version },
        { label: t('deployment.rollback.transition'), value: `${review.currentRelease} → ${review.previousRelease}` },
        { label: t('deployment.risk'), value: t(`runbook.risk.${review.declaredRisk}` as LocaleKey) },
      ];
    }
    const review = workflow.frozenReview?.review;
    if (!review) return [];
    const facts: DeploymentApprovalFact[] = [
      { label: t('deployment.environment'), value: review.environment },
      { label: t('deployment.version'), value: review.version },
      { label: t('deployment.risk'), value: t(`runbook.risk.${review.declaredRisk}` as LocaleKey) },
    ];
    if (approvalIntent.kind === 'single' && workflow.frozenReview?.kind === 'single') {
      facts.push({
        label: t('deployment.target'),
        value: `${workflow.frozenReview.review.target.username}@${workflow.frozenReview.review.target.host}:${workflow.frozenReview.review.target.port}`,
      });
    }
    if (approvalIntent.kind === 'batch' && workflow.frozenReview?.kind === 'rollout') {
      const batch = workflow.frozenReview.review.batches[approvalIntent.batchIndex];
      facts.push(
        { label: t('deployment.batch'), value: `${approvalIntent.batchIndex + 1}/${workflow.frozenReview.review.batches.length} · ${batch?.kind}` },
        { label: t('deployment.targets'), value: batch?.profileIds.length ?? 0 },
      );
    }
    return facts;
  }, [approvalIntent, t, workflow.frozenReview]);

  const approvalCopy = approvalIntent?.kind === 'rollback'
    ? {
        title: t('deployment.rollback.approvalTitle'),
        description: t('deployment.rollback.approvalDescription'),
        confirmation: t('deployment.rollback.confirmation'),
        confirmLabel: t('deployment.rollback.execute'),
        destructive: true,
      }
    : approvalIntent?.kind === 'batch'
      ? {
          title: t(approvalIntent.start ? 'deployment.approval.canaryTitle' : 'deployment.approval.batchTitle'),
          description: t('deployment.approval.batchDescription'),
          confirmation: t('deployment.approval.batchConfirmation'),
          confirmLabel: t(approvalIntent.start ? 'deployment.approval.executeCanary' : 'deployment.approval.executeBatch'),
          destructive: workflow.frozenReview?.review.declaredRisk === 'destructive',
        }
      : {
          title: t('deployment.approval.singleTitle'),
          description: t('deployment.approval.singleDescription'),
          confirmation: t('deployment.approval.singleConfirmation'),
          confirmLabel: t('deployment.approval.executeSingle'),
          destructive: workflow.frozenReview?.review.declaredRisk === 'destructive',
        };

  return (
    <WorkbenchPage data-slot="deployment-panel">
      <WorkbenchPageHeader
        icon={RocketIcon}
        title={t('deployment.title')}
        titleMeta={(
          <Badge variant={backendStatus === 'available' ? 'outline' : 'destructive'}>
            {t(`deployment.backend.${backendStatus}` as LocaleKey)}
          </Badge>
        )}
        description={sourcePath ? `${t('deployment.description')} · ${sourcePath}` : t('deployment.description')}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => void handleImport()} disabled={draftLocked}>
              <FileUpIcon data-icon="inline-start" />
              {t('deployment.import')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={!validation.normalizedText || busy === 'export'}>
              <FileDownIcon data-icon="inline-start" />
              {t('deployment.export')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setJsonOpen(true)}>
              <BracesIcon data-icon="inline-start" />
              {t('deployment.viewJson')}
            </Button>
          </>
        )}
      />

      <ScrollArea className="min-h-0 flex-1">
        <WorkbenchPageContent className="@container">
          {backendStatus === 'unavailable' && (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>{t('deployment.backendUnavailable')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>{error}</span>
                <div>
                  <Button size="sm" variant="outline" onClick={() => void loadAuthoritativeState()}>
                    <RefreshCwIcon data-icon="inline-start" />
                    {t('common.retry')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {error && backendStatus !== 'unavailable' && (
            <Alert variant="destructive">
              <XCircleIcon />
              <AlertTitle>{t('deployment.actionFailed')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {(reviewExpired || frozenTargetDrift) && (
            <Alert variant="destructive">
              <ShieldCheckIcon />
              <AlertTitle>{t(reviewExpired ? 'deployment.reviewExpired' : 'deployment.targetDrift')}</AlertTitle>
              <AlertDescription>{t(reviewExpired ? 'deployment.reviewExpiredDescription' : 'deployment.targetDriftDescription')}</AlertDescription>
            </Alert>
          )}

          {workflow.frozenReview && (
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>{t('deployment.reviewFrozen')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>{t('deployment.reviewFrozenDescription')}</span>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setWorkflow({ draft: workflow.draft });
                      setRecoverySource(undefined);
                      resetExecutionState();
                    }}
                  >
                    {t('deployment.discardReview')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid min-w-0 grid-cols-1 items-start gap-4 @min-[68rem]:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t('deployment.template.title')}</CardTitle>
                  <CardDescription>{t('deployment.template.description')}</CardDescription>
                  <CardAction><Badge variant="outline">v2</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field data-disabled={draftLocked}>
                      <FieldLabel>{t('deployment.template.label')}</FieldLabel>
                      <ToggleGroup
                        value={selectedTemplate ? [selectedTemplate] : []}
                        onValueChange={(values) => {
                          const templateId = values[0] as DeploymentTemplateId | undefined;
                          if (templateId) replaceDraft(createDeploymentTemplate(templateId));
                        }}
                        variant="outline"
                        spacing={0}
                        className="grid w-full grid-cols-1 @min-[38rem]:grid-cols-2"
                        disabled={draftLocked}
                        aria-label={t('deployment.template.label')}
                      >
                        <ToggleGroupItem value="singleSystemdWeb">{t('deployment.template.single')}</ToggleGroupItem>
                        <ToggleGroupItem value="canaryRollingSystemdWeb">{t('deployment.template.rollout')}</ToggleGroupItem>
                      </ToggleGroup>
                      <FieldDescription>{t('deployment.template.safety')}</FieldDescription>
                    </Field>

                    <FieldGroup className="grid grid-cols-1 gap-4 @min-[38rem]:grid-cols-2">
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-name">{t('deployment.name')}</FieldLabel>
                        <Input id="deployment-name" value={document.name} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.name = event.target.value; })} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-application">{t('deployment.applicationId')}</FieldLabel>
                        <Input id="deployment-application" value={document.deployment.applicationId} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.deployment.applicationId = event.target.value; next.id = `${event.target.value}-${next.deployment.environment}`; })} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-environment">{t('deployment.environment')}</FieldLabel>
                        <Input id="deployment-environment" value={document.deployment.environment} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.deployment.environment = event.target.value; next.id = `${next.deployment.applicationId}-${event.target.value}`; })} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-version">{t('deployment.version')}</FieldLabel>
                        <Input id="deployment-version" value={document.deployment.version} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.deployment.version = event.target.value; })} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-id">{t('deployment.deploymentId')}</FieldLabel>
                        <Input id="deployment-id" value={document.deployment.id} disabled={draftLocked} onChange={(event) => updateDeploymentId(event.target.value)} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-root">{t('deployment.rootDirectory')}</FieldLabel>
                        <Input id="deployment-root" value={document.release.rootDirectory} disabled={draftLocked} onChange={(event) => updateRootDirectory(event.target.value)} />
                      </Field>
                    </FieldGroup>
                    <Field data-disabled={draftLocked}>
                      <FieldLabel htmlFor="deployment-description">{t('deployment.documentDescription')}</FieldLabel>
                      <Textarea id="deployment-description" value={document.description} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.description = event.target.value; })} />
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('deployment.artifact.title')}</CardTitle>
                  <CardDescription>{t('deployment.artifact.description')}</CardDescription>
                  <CardAction><Badge variant="outline">{document.artifacts.length}</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  {firstArtifact ? (
                    <FieldGroup>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-artifact-source">{t('deployment.artifact.source')}</FieldLabel>
                        <Input id="deployment-artifact-source" value={firstArtifact.sourceUri} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.artifacts[0]!.sourceUri = event.target.value; })} />
                        <FieldDescription>{t('deployment.artifact.sourceDescription')}</FieldDescription>
                      </Field>
                      <Field data-disabled={draftLocked} data-invalid={firstArtifact.sha256.length !== 64}>
                        <FieldLabel htmlFor="deployment-artifact-sha">SHA-256</FieldLabel>
                        <Input id="deployment-artifact-sha" value={firstArtifact.sha256} disabled={draftLocked} aria-invalid={firstArtifact.sha256.length !== 64} onChange={(event) => editDocument((next) => { next.artifacts[0]!.sha256 = event.target.value; })} />
                      </Field>
                      <Field data-disabled={draftLocked}>
                        <FieldLabel htmlFor="deployment-artifact-target">{t('deployment.artifact.targetPath')}</FieldLabel>
                        <Input id="deployment-artifact-target" value={firstArtifact.targetPath} disabled={draftLocked} onChange={(event) => editDocument((next) => { next.artifacts[0]!.targetPath = event.target.value; })} />
                      </Field>
                    </FieldGroup>
                  ) : <FieldError>{t('deployment.artifact.required')}</FieldError>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('deployment.serviceHealth.title')}</CardTitle>
                  <CardDescription>{t('deployment.serviceHealth.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <FieldGroup className="grid grid-cols-1 gap-4 @min-[38rem]:grid-cols-2">
                      <Field data-disabled={draftLocked || !firstService}>
                        <FieldLabel htmlFor="deployment-service-unit">{t('deployment.serviceUnit')}</FieldLabel>
                        <Input id="deployment-service-unit" value={firstService?.unit ?? ''} disabled={draftLocked || !firstService} onChange={(event) => editDocument((next) => { if (next.services[0]) next.services[0].unit = event.target.value; })} />
                      </Field>
                      <Field data-disabled={draftLocked || !firstServiceAction}>
                        <FieldLabel>{t('deployment.serviceAction')}</FieldLabel>
                        <Select
                          items={{ start: 'start', restart: 'restart', reload: 'reload' }}
                          value={firstServiceAction?.action ?? null}
                          disabled={draftLocked || !firstServiceAction}
                          onValueChange={(value) => editDocument((next) => { if (next.serviceActions[0] && value) next.serviceActions[0].action = value; })}
                        >
                          <SelectTrigger aria-label={t('deployment.serviceAction')}><SelectValue /></SelectTrigger>
                          <SelectContent><SelectGroup>{['start', 'restart', 'reload'].map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</SelectGroup></SelectContent>
                        </Select>
                      </Field>
                    </FieldGroup>
                    <Field data-disabled={draftLocked || !httpCheck}>
                      <FieldLabel htmlFor="deployment-health-url">{t('deployment.healthUrl')}</FieldLabel>
                      <Input id="deployment-health-url" value={httpCheck?.url ?? ''} disabled={draftLocked || !httpCheck} onChange={(event) => editDocument((next) => { const check = next.verification.checks.find((entry) => entry.kind === 'http'); if (check?.kind === 'http') check.url = event.target.value; })} />
                    </Field>
                    <Field className="flex-row items-start gap-3" data-disabled={draftLocked}>
                      <Checkbox id="deployment-privilege" checked={document.security.allowPrivilegeEscalation} disabled={draftLocked} onCheckedChange={(checked) => editDocument((next) => { next.security.allowPrivilegeEscalation = checked === true; })} />
                      <div className="flex flex-col gap-1">
                        <FieldLabel htmlFor="deployment-privilege" className="text-foreground">{t('deployment.allowPrivilegeEscalation')}</FieldLabel>
                        <FieldDescription>{t('deployment.allowPrivilegeEscalationDescription')}</FieldDescription>
                      </div>
                    </Field>
                  </FieldGroup>
                </CardContent>
                <CardFooter className="flex-wrap gap-2">
                  <Badge variant="outline">atomicSymlinkSwap</Badge>
                  <Badge variant="outline">systemd</Badge>
                  <Badge variant="outline">{document.verification.checks.length} {t('deployment.checks')}</Badge>
                  <Badge variant="outline">{t('deployment.rollback.separate')}</Badge>
                </CardFooter>
              </Card>
            </div>

            <div className="flex min-w-0 flex-col gap-4 @min-[68rem]:sticky @min-[68rem]:top-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t('deployment.targetsAndPolicy')}</CardTitle>
                  <CardDescription>{t('deployment.targetsDescription')}</CardDescription>
                  <CardAction><Badge variant="secondary">{workflow.draft.targetProfileIds.length}</Badge></CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <Field>
                    <FieldLabel>{t('deployment.mode')}</FieldLabel>
                    <ToggleGroup
                      value={[workflow.draft.mode]}
                      onValueChange={(values) => {
                        const mode = values[0] as DeploymentWorkflowDraft['mode'] | undefined;
                        if (mode) editDraft((draft) => ({ ...draft, mode, targetProfileIds: mode === 'single' ? draft.targetProfileIds.slice(0, 1) : draft.targetProfileIds }));
                      }}
                      variant="outline"
                      spacing={0}
                      className="w-full"
                      disabled={draftLocked}
                      aria-label={t('deployment.mode')}
                    >
                      <ToggleGroupItem value="single" className="flex-1">{t('deployment.mode.single')}</ToggleGroupItem>
                      <ToggleGroupItem value="rollout" className="flex-1">{t('deployment.mode.rollout')}</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>

                  <Field data-invalid={missingTargetIds.length > 0 || duplicateHostIdentity} data-disabled={draftLocked}>
                    <FieldLabel>{t('deployment.explicitTargets')}</FieldLabel>
                    <ScrollArea className="h-64 rounded-lg border" tabIndex={0}>
                      <FieldGroup className="gap-1 p-2">
                        {profiles.map((profile) => {
                          const checked = workflow.draft.targetProfileIds.includes(profile.id);
                          return (
                            <Field key={profile.id} className="flex-row items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
                              <Checkbox
                                id={`deployment-target-${profile.id}`}
                                checked={checked}
                                disabled={draftLocked || (workflow.draft.mode === 'single' && !checked && workflow.draft.targetProfileIds.length === 1)}
                                onCheckedChange={(nextChecked) => editDraft((draft) => ({
                                  ...draft,
                                  targetProfileIds: nextChecked === true
                                    ? [...draft.targetProfileIds, profile.id]
                                    : draft.targetProfileIds.filter((id) => id !== profile.id),
                                }))}
                              />
                              <FieldLabel htmlFor={`deployment-target-${profile.id}`} className="min-w-0 flex-1 text-foreground">
                                <span className="block truncate">{profile.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">{profile.username}@{profile.host}:{profile.port}</span>
                              </FieldLabel>
                            </Field>
                          );
                        })}
                      </FieldGroup>
                    </ScrollArea>
                    {missingTargetIds.length > 0 && <FieldError>{t('deployment.error.missingTargets', { count: missingTargetIds.length })}</FieldError>}
                    {duplicateHostIdentity && <FieldError>{t('deployment.error.duplicateHost')}</FieldError>}
                  </Field>

                  {workflow.draft.targetProfileIds.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-xs text-muted-foreground">{t('deployment.targetOrder')}</span>
                      {workflow.draft.targetProfileIds.map((profileId, index) => (
                        <div key={profileId} className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2">
                          <Badge variant="outline">{index + 1}</Badge>
                          <span className="min-w-0 flex-1 truncate">{profiles.find((profile) => profile.id === profileId)?.name ?? profileId}</span>
                          <Button size="icon" variant="ghost" aria-label={t('deployment.moveUp')} disabled={draftLocked || index === 0} onClick={() => editDraft((draft) => { const ids = [...draft.targetProfileIds]; [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; return { ...draft, targetProfileIds: ids }; })}><ArrowUpIcon /></Button>
                          <Button size="icon" variant="ghost" aria-label={t('deployment.moveDown')} disabled={draftLocked || index === workflow.draft.targetProfileIds.length - 1} onClick={() => editDraft((draft) => { const ids = [...draft.targetProfileIds]; [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; return { ...draft, targetProfileIds: ids }; })}><ArrowDownIcon /></Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {workflow.draft.mode === 'rollout' && (
                    <>
                      <Separator />
                      <FieldGroup className="grid grid-cols-1 gap-4 @min-[32rem]:grid-cols-2">
                        <Field data-disabled={draftLocked}>
                          <FieldLabel htmlFor="deployment-canary-count">{t('deployment.canaryCount')}</FieldLabel>
                          <Input id="deployment-canary-count" type="number" min={1} value={workflow.draft.rolloutPolicy.canary.value} disabled={draftLocked} onChange={(event) => editDraft((draft) => ({ ...draft, rolloutPolicy: { ...draft.rolloutPolicy, canary: { mode: 'count', value: Number(event.target.value) } } }))} />
                        </Field>
                        <Field data-disabled={draftLocked}>
                          <FieldLabel htmlFor="deployment-batch-size">{t('deployment.batchSize')}</FieldLabel>
                          <Input id="deployment-batch-size" type="number" min={1} max={100} value={workflow.draft.rolloutPolicy.batchSize} disabled={draftLocked} onChange={(event) => editDraft((draft) => ({ ...draft, rolloutPolicy: { ...draft.rolloutPolicy, batchSize: Number(event.target.value) } }))} />
                        </Field>
                        <Field data-disabled={draftLocked}>
                          <FieldLabel htmlFor="deployment-parallel">{t('deployment.maxParallel')}</FieldLabel>
                          <Input id="deployment-parallel" type="number" min={1} max={32} value={workflow.draft.rolloutPolicy.maxParallel} disabled={draftLocked} onChange={(event) => editDraft((draft) => ({ ...draft, rolloutPolicy: { ...draft.rolloutPolicy, maxParallel: Number(event.target.value) } }))} />
                        </Field>
                        <Field data-disabled={draftLocked}>
                          <FieldLabel htmlFor="deployment-healthy">{t('deployment.minHealthyPercent')}</FieldLabel>
                          <Input id="deployment-healthy" type="number" min={1} max={100} value={workflow.draft.rolloutPolicy.minHealthyPercent} disabled={draftLocked} onChange={(event) => editDraft((draft) => ({ ...draft, rolloutPolicy: { ...draft.rolloutPolicy, minHealthyPercent: Number(event.target.value) } }))} />
                        </Field>
                      </FieldGroup>
                      <Alert>
                        <ShieldCheckIcon />
                        <AlertTitle>{t('deployment.manualBatchGate')}</AlertTitle>
                        <AlertDescription>{t('deployment.manualBatchGateDescription')}</AlertDescription>
                      </Alert>
                    </>
                  )}
                </CardContent>
                <CardFooter className="flex-col items-stretch gap-3">
                  {validation.errors.length > 0 && (
                    <Alert variant="destructive">
                      <XCircleIcon />
                      <AlertTitle>{t('deployment.validationFailed')}</AlertTitle>
                      <AlertDescription><ul className="list-disc pl-4">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></AlertDescription>
                    </Alert>
                  )}
                  {recoverySource && !workflow.frozenReview && (
                    <Alert>
                      <RefreshCwIcon />
                      <AlertTitle>{t('deployment.recovery.loaded')}</AlertTitle>
                      <AlertDescription>{t('deployment.recovery.loadedDescription')}</AlertDescription>
                    </Alert>
                  )}
                  {!workflow.frozenReview ? (
                    <Button
                      onClick={() => void handleReview()}
                      disabled={backendStatus !== 'available' || validation.errors.length > 0 || missingTargetIds.length > 0 || duplicateHostIdentity || Boolean(busy)}
                    >
                      {busy === 'review' && <Spinner data-icon="inline-start" />}
                      {t(recoverySource ? 'deployment.reviewRecovery' : 'deployment.review')}
                    </Button>
                  ) : workflow.frozenReview.kind === 'single' ? (
                    <Button
                      variant={workflow.frozenReview.review.declaredRisk === 'destructive' ? 'destructive' : 'default'}
                      disabled={!canApprove || Boolean(busy)}
                      onClick={() => setApprovalIntent({ kind: 'single' })}
                    >
                      {t('deployment.approval.reviewSingle')}
                    </Button>
                  ) : currentBatch ? (
                    <Button
                      variant={workflow.frozenReview.review.declaredRisk === 'destructive' ? 'destructive' : 'default'}
                      disabled={!canApprove || Boolean(busy)}
                      onClick={() => setApprovalIntent({ kind: 'batch', batchIndex: currentBatch.batchIndex, start: batchIsStart })}
                    >
                      {t(batchIsStart ? 'deployment.approval.reviewCanary' : 'deployment.approval.reviewBatch', { batch: currentBatch.batchIndex + 1 })}
                    </Button>
                  ) : null}
                </CardFooter>
              </Card>
            </div>
          </div>

          {workflow.frozenReview && (
            <Card data-slot="deployment-review-summary">
              <CardHeader>
                <CardTitle>{t('deployment.reviewSummary')}</CardTitle>
                <CardDescription>{workflow.frozenReview.review.applicationId} · {workflow.frozenReview.review.environment} · {workflow.frozenReview.review.version}</CardDescription>
                <CardAction><Badge variant={riskVariant(workflow.frozenReview.review.declaredRisk)}>{t(`runbook.risk.${workflow.frozenReview.review.declaredRisk}` as LocaleKey)}</Badge></CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="grid grid-cols-1 gap-3 @min-[42rem]:grid-cols-3">
                  <div><dt className="text-xs text-muted-foreground">{t('deployment.documentDigest')}</dt><dd className="break-all font-mono text-xs">{workflow.frozenReview.review.documentDigest}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t('deployment.planDigest')}</dt><dd className="break-all font-mono text-xs">{workflow.frozenReview.review.planDigest}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t('deployment.reviewExpires')}</dt><dd>{new Date(workflow.frozenReview.review.expiresAt).toLocaleString(locale)}</dd></div>
                </dl>
                {workflow.frozenReview.kind === 'single' ? (
                  <Alert>
                    <ShieldCheckIcon />
                    <AlertTitle>{workflow.frozenReview.review.target.profileId}</AlertTitle>
                    <AlertDescription>{workflow.frozenReview.review.target.username}@{workflow.frozenReview.review.target.host}:{workflow.frozenReview.review.target.port} · {workflow.frozenReview.review.actions.length} {t('deployment.actions')}</AlertDescription>
                  </Alert>
                ) : (
                  <Table>
                    <TableHeader><TableRow><TableHead>{t('deployment.batch')}</TableHead><TableHead>{t('deployment.kind')}</TableHead><TableHead>{t('deployment.targets')}</TableHead><TableHead>{t('deployment.healthGate')}</TableHead></TableRow></TableHeader>
                    <TableBody>{workflow.frozenReview.review.batches.map((batch) => <TableRow key={batch.batchIndex}><TableCell>{batch.batchIndex + 1}</TableCell><TableCell><Badge variant="outline">{batch.kind}</Badge></TableCell><TableCell>{batch.profileIds.length}</TableCell><TableCell>{batch.requiredHealthy}/{batch.profileIds.length} · max {batch.maximumFailures}</TableCell></TableRow>)}</TableBody>
                  </Table>
                )}
              </CardContent>
              {busy === 'execute' && (
                <CardFooter>
                  <Button variant="destructive" onClick={() => void handleCancel()}>
                    <SquareIcon data-icon="inline-start" />
                    {t('deployment.cancelExact', {
                      environment: workflow.frozenReview.review.environment,
                      count: workflow.frozenReview.kind === 'single'
                        ? 1
                        : workflow.frozenReview.review.profileIds.length,
                    })}
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}

          {singleResult && (
            <Card data-slot="deployment-single-result">
              <CardHeader><CardTitle>{t('deployment.result.single')}</CardTitle><CardDescription>{singleResult.target.profileId} · {singleResult.version}</CardDescription><CardAction><Badge variant={phaseVariant(singleResult.phase)}>{singleResult.phase}</Badge></CardAction></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Table><TableHeader><TableRow><TableHead>{t('deployment.action')}</TableHead><TableHead>{t('deployment.kind')}</TableHead><TableHead>{t('deployment.status')}</TableHead></TableRow></TableHeader><TableBody>{singleResult.actions.map((action) => <TableRow key={action.actionId}><TableCell>{action.actionId}</TableCell><TableCell>{action.kind}</TableCell><TableCell><Badge variant={phaseVariant(action.status)}>{action.status}</Badge></TableCell></TableRow>)}</TableBody></Table>
                {singleResult.healthChecks.length > 0 && (
                  <Table>
                    <TableHeader><TableRow><TableHead>{t('deployment.evidence')}</TableHead><TableHead>{t('deployment.kind')}</TableHead><TableHead>{t('deployment.status')}</TableHead></TableRow></TableHeader>
                    <TableBody>{singleResult.healthChecks.map((check) => <TableRow key={check.checkId}><TableCell>{check.checkId}</TableCell><TableCell>{check.kind}</TableCell><TableCell><Badge variant={phaseVariant(check.status)}>{check.status}</Badge></TableCell></TableRow>)}</TableBody>
                  </Table>
                )}
                {singleResult.error && <Alert variant="destructive"><XCircleIcon /><AlertTitle>{singleResult.errorCategory}</AlertTitle><AlertDescription>{singleResult.error}</AlertDescription></Alert>}
              </CardContent>
              {singleResult.phase !== 'succeeded' && singleResult.rollbackSnapshot.activationChanged && (
                <CardFooter><Button variant="destructive" onClick={() => void reviewRollback(singleResult.target.profileId, singleResult.operationId)} disabled={Boolean(busy)}><RotateCcwIcon data-icon="inline-start" />{t('deployment.rollback.review')}</Button></CardFooter>
              )}
            </Card>
          )}

          {rolloutDetail && (
            <Card data-slot="deployment-rollout-progress">
              <CardHeader>
                <CardTitle>{t('deployment.rolloutProgress')}</CardTitle>
                <CardDescription>{rolloutDetail.succeededTargets}/{rolloutDetail.totalTargets} {t('deployment.targetsSucceeded')} · {rolloutDetail.failedTargets} {t('deployment.targetsFailed')}</CardDescription>
                <CardAction><Badge variant={phaseVariant(rolloutDetail.phase)}>{rolloutDetail.phase}</Badge></CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {rolloutDetail.circuitOpen && (
                  <Alert variant="destructive"><SquareIcon /><AlertTitle>{t('deployment.circuitOpen')}</AlertTitle><AlertDescription>{t(`deployment.circuit.${rolloutDetail.circuitReason ?? 'planDrift'}` as LocaleKey)}</AlertDescription></Alert>
                )}
                {rolloutDetail.recoveryRequired && (
                  <Alert><RefreshCwIcon /><AlertTitle>{t('deployment.recovery.required')}</AlertTitle><AlertDescription>{t('deployment.recovery.requiredDescription')}</AlertDescription></Alert>
                )}
                <Table>
                  <TableHeader><TableRow><TableHead>{t('deployment.batch')}</TableHead><TableHead>{t('deployment.kind')}</TableHead><TableHead>{t('deployment.status')}</TableHead><TableHead>{t('deployment.healthGate')}</TableHead></TableRow></TableHeader>
                  <TableBody>{rolloutDetail.batches.map((batch) => <TableRow key={batch.batchIndex}><TableCell>{batch.batchIndex + 1}</TableCell><TableCell>{batch.kind}</TableCell><TableCell><Badge variant={phaseVariant(batch.status)}>{batch.status}</Badge></TableCell><TableCell>{batch.health.healthy}/{batch.health.total} · {batch.health.healthyPercent}%</TableCell></TableRow>)}</TableBody>
                </Table>
                <ScrollArea className="max-h-96 rounded-lg border" horizontal>
                  <Table>
                    <TableHeader><TableRow><TableHead>#</TableHead><TableHead>{t('deployment.target')}</TableHead><TableHead>{t('deployment.batch')}</TableHead><TableHead>{t('deployment.status')}</TableHead><TableHead>{t('deployment.evidence')}</TableHead></TableRow></TableHeader>
                    <TableBody>{rolloutDetail.targets.map((target) => <TableRow key={target.targetIndex}><TableCell>{target.targetIndex + 1}</TableCell><TableCell>{target.profileId}<div className="text-xs text-muted-foreground">{target.target.username}@{target.target.host}:{target.target.port}</div></TableCell><TableCell>{target.batchIndex + 1}</TableCell><TableCell><Badge variant={phaseVariant(target.status)}>{target.status}</Badge>{target.recoveryRequired && <Badge variant="destructive">{t('deployment.recovery.required')}</Badge>}</TableCell><TableCell className="max-w-md whitespace-normal">{target.error ?? target.result?.healthChecks.map((check) => `${check.checkId}:${check.status}`).join(', ') ?? '—'}</TableCell></TableRow>)}</TableBody>
                  </Table>
                </ScrollArea>
                {rolloutDetail.rollbackSuggestions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="font-medium">{t('deployment.rollback.suggestions')}</span>
                    {rolloutDetail.rollbackSuggestions.map((suggestion) => <div key={suggestion.sourceOperationId} className="flex flex-col gap-2 rounded-lg border p-3 @min-[36rem]:flex-row @min-[36rem]:items-center @min-[36rem]:justify-between"><div><div className="font-medium">{suggestion.profileId}</div><div className="text-xs text-muted-foreground">{suggestion.sourceOperationId} · {t('deployment.rollback.separate')}</div></div><Button variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => void reviewRollback(suggestion.profileId, suggestion.sourceOperationId)}><RotateCcwIcon data-icon="inline-start" />{t('deployment.rollback.review')}</Button></div>)}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {rollbackResult && (
            <Card data-slot="deployment-rollback-result"><CardHeader><CardTitle>{t('deployment.rollback.result')}</CardTitle><CardDescription>{rollbackResult.target.profileId} · {rollbackResult.reactivation.currentRelease} → {rollbackResult.reactivation.previousRelease}</CardDescription><CardAction><Badge variant={phaseVariant(rollbackResult.phase)}>{rollbackResult.phase}</Badge></CardAction></CardHeader><CardContent>{rollbackResult.error ? <Alert variant="destructive"><XCircleIcon /><AlertTitle>{rollbackResult.errorCategory}</AlertTitle><AlertDescription>{rollbackResult.error}</AlertDescription></Alert> : <Alert><ShieldCheckIcon /><AlertTitle>{t('deployment.rollback.completed')}</AlertTitle><AlertDescription>{rollbackResult.healthEvidence.map((check) => `${check.checkId}: ${check.status}`).join(' · ')}</AlertDescription></Alert>}</CardContent></Card>
          )}

          {(recoverableRollouts.length > 0 || recoverableOperations.length > 0) && (
            <Card data-slot="deployment-recovery">
              <CardHeader><CardTitle>{t('deployment.recovery.title')}</CardTitle><CardDescription>{t('deployment.recovery.description')}</CardDescription><CardAction><Badge variant="destructive">{recoverableRollouts.length + recoverableOperations.length}</Badge></CardAction></CardHeader>
              <CardContent className="flex flex-col gap-3">
                {recoverableRollouts.map((summary) => <div key={summary.rolloutId} className="flex flex-col gap-2 rounded-lg border p-3 @min-[42rem]:flex-row @min-[42rem]:items-center @min-[42rem]:justify-between"><div><div className="font-medium">{summary.applicationId} · {summary.environment} · {summary.version}</div><div className="text-xs text-muted-foreground">{summary.rolloutId} · {summary.succeededTargets}/{summary.totalTargets} · {summary.circuitReason}</div></div><Button size="sm" variant="outline" onClick={() => void loadRecoveryRollout(summary)} disabled={Boolean(busy)}><RefreshCwIcon data-icon="inline-start" />{t('deployment.recovery.review')}</Button></div>)}
                {recoverableOperations.map((summary) => <div key={summary.operationId} className="flex flex-col gap-2 rounded-lg border p-3 @min-[42rem]:flex-row @min-[42rem]:items-center @min-[42rem]:justify-between"><div><div className="font-medium">{summary.applicationId} · {summary.environment} · {summary.version}</div><div className="text-xs text-muted-foreground">{summary.operationId} · interrupted · recoveryRequired</div></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void loadRecoveryOperation(summary)} disabled={Boolean(busy)}>{t('deployment.recovery.loadForward')}</Button><Button size="sm" variant="destructive" onClick={() => void reviewRecoveryOperationRollback(summary)} disabled={Boolean(busy)}>{t('deployment.rollback.review')}</Button></div></div>)}
              </CardContent>
            </Card>
          )}
        </WorkbenchPageContent>
      </ScrollArea>

      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>{t('deployment.normalizedJson')}</DialogTitle><DialogDescription>{t('deployment.normalizedJsonDescription')}</DialogDescription></DialogHeader>
          <ScrollArea className="h-[min(70vh,42rem)] rounded-lg border" horizontal tabIndex={0}><pre className="min-w-max p-4 text-xs">{normalizedJson}</pre></ScrollArea>
        </DialogContent>
      </Dialog>

      <DeploymentApprovalDialog
        open={Boolean(approvalIntent)}
        title={approvalCopy.title}
        description={approvalCopy.description}
        facts={approvalFacts}
        confirmation={approvalCopy.confirmation}
        confirmLabel={approvalCopy.confirmLabel}
        destructive={approvalCopy.destructive}
        busy={busy === 'execute' || busy === 'rollbackExecute'}
        onOpenChange={(open) => { if (!open) setApprovalIntent(undefined); }}
        onConfirm={handleApprovalConfirm}
      />
    </WorkbenchPage>
  );
};
