import React from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  CloudUploadIcon,
  HistoryIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import type {
  DeploymentPreflightCheckSummary,
  DeploymentTargetIdentitySnapshot,
  DeploymentWorkflowCreate,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import type { ConnectionProfile } from '@/types';
import { getErrorMessage } from '@/lib/error';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader } from './workbench-page';
import { DeploymentRunHistory } from './deployment-run-history';

interface WorkflowDraft {
  name: string;
  sourceDirectory: string;
  buildContext: string;
  dockerfile: string;
  platform: 'linux/amd64' | 'linux/arm64';
  imageRepository: string;
  compression: 'zstd' | 'gzip' | 'none';
  profileId: string;
  remoteRoot: string;
  composeProject: string;
  composeFiles: string;
  services: string;
  pullBeforeUp: boolean;
  healthPath: string;
  healthStatus: string;
  healthTimeout: string;
  reloadNginxAfterHealthy: boolean;
  releasesToKeep: string;
  enabled: boolean;
}

const PLATFORM_OPTIONS: ReadonlyArray<{
  value: WorkflowDraft['platform'];
  label: string;
}> = [
  { value: 'linux/amd64', label: 'linux/amd64' },
  { value: 'linux/arm64', label: 'linux/arm64' },
];

function draftFor(
  workflow: DeploymentWorkflowRecord | null,
  defaultProfileId: string,
): WorkflowDraft {
  if (!workflow) {
    return {
      name: '',
      sourceDirectory: '',
      buildContext: '.',
      dockerfile: 'Dockerfile',
      platform: 'linux/amd64',
      imageRepository: 'shellspan/app',
      compression: 'zstd',
      profileId: defaultProfileId,
      remoteRoot: '/srv/shellspan/app',
      composeProject: 'app',
      composeFiles: 'compose.yaml',
      services: '',
      pullBeforeUp: true,
      healthPath: '',
      healthStatus: '200',
      healthTimeout: '30',
      reloadNginxAfterHealthy: false,
      releasesToKeep: '3',
      enabled: true,
    };
  }
  return {
    name: workflow.name,
    sourceDirectory: workflow.definition.sourceDirectory,
    buildContext: workflow.definition.build.context,
    dockerfile: workflow.definition.build.dockerfile,
    platform: workflow.definition.build.platform,
    imageRepository: workflow.definition.build.imageRepository,
    compression: workflow.definition.build.compression,
    profileId: workflow.connectionProfileId,
    remoteRoot: workflow.definition.target.remoteRoot,
    composeProject: workflow.definition.compose.projectName,
    composeFiles: workflow.definition.compose.files.join('\n'),
    services: workflow.definition.compose.services.join('\n'),
    pullBeforeUp: workflow.definition.compose.pullBeforeUp,
    healthPath: workflow.definition.healthCheck?.path ?? '',
    healthStatus: String(workflow.definition.healthCheck?.expectedStatus ?? 200),
    healthTimeout: String(workflow.definition.healthCheck?.timeoutSeconds ?? 30),
    reloadNginxAfterHealthy: workflow.definition.reloadNginxAfterHealthy,
    releasesToKeep: String(workflow.definition.releasesToKeep),
    enabled: workflow.enabled,
  };
}

function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function workflowInput(draft: WorkflowDraft): DeploymentWorkflowCreate {
  const healthPath = draft.healthPath.trim();
  return {
    name: draft.name.trim(),
    definition: {
      schemaVersion: 2,
      sourceDirectory: draft.sourceDirectory.trim(),
      build: {
        context: draft.buildContext.trim(),
        dockerfile: draft.dockerfile.trim(),
        platform: draft.platform,
        imageRepository: draft.imageRepository.trim(),
        compression: draft.compression,
      },
      target: {
        connectionProfileId: draft.profileId,
        remoteRoot: draft.remoteRoot.trim(),
      },
      compose: {
        projectName: draft.composeProject.trim(),
        files: lines(draft.composeFiles),
        services: lines(draft.services),
        pullBeforeUp: draft.pullBeforeUp,
      },
      healthCheck: healthPath ? {
        path: healthPath,
        expectedStatus: Number(draft.healthStatus),
        timeoutSeconds: Number(draft.healthTimeout),
      } : null,
      reloadNginxAfterHealthy: draft.reloadNginxAfterHealthy,
      releasesToKeep: Number(draft.releasesToKeep),
    },
    enabled: draft.enabled,
  };
}

function validDraft(draft: WorkflowDraft): boolean {
  const input = workflowInput(draft);
  return Boolean(
    input.name
    && input.definition.sourceDirectory.startsWith('/')
    && Boolean(input.definition.build.context)
    && Boolean(input.definition.build.dockerfile)
    && Boolean(input.definition.build.imageRepository)
    && input.definition.target.connectionProfileId
    && input.definition.target.remoteRoot.startsWith('/')
    && input.definition.target.remoteRoot !== '/'
    && input.definition.compose.projectName
    && input.definition.compose.files.length > 0
    && Number.isInteger(input.definition.releasesToKeep)
    && input.definition.releasesToKeep >= 1
    && input.definition.releasesToKeep <= 20
    && (!input.definition.reloadNginxAfterHealthy || Boolean(input.definition.healthCheck))
    && (!input.definition.healthCheck || (
      Number.isInteger(input.definition.healthCheck.expectedStatus)
      && input.definition.healthCheck.expectedStatus >= 100
      && input.definition.healthCheck.expectedStatus <= 599
      && Number.isInteger(input.definition.healthCheck.timeoutSeconds)
      && input.definition.healthCheck.timeoutSeconds >= 1
      && input.definition.healthCheck.timeoutSeconds <= 300
    )),
  );
}

function connectionProfileLabel(profile: ConnectionProfile): string {
  return `${profile.name} · ${profile.username}@${profile.host}`;
}

interface WorkflowDialogProps {
  open: boolean;
  workflow: DeploymentWorkflowRecord | null;
  defaultProfileId: string;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
}

const WorkflowDialog: React.FC<WorkflowDialogProps> = ({
  open,
  workflow,
  defaultProfileId,
  saving,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const admissionsEnabled = useDeploymentStore(
    (state) => state.runtimeCapabilities?.admissionsEnabled === true,
  );
  const createWorkflow = useDeploymentStore((state) => state.createWorkflow);
  const updateWorkflow = useDeploymentStore((state) => state.updateWorkflow);
  const addToast = useToastStore((state) => state.addToast);
  const [draft, setDraft] = React.useState<WorkflowDraft>(() => draftFor(workflow, defaultProfileId));
  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: connectionProfileLabel(profile),
  }));
  const compressionOptions: ReadonlyArray<{
    value: WorkflowDraft['compression'];
    label: string;
  }> = [
    { value: 'zstd', label: 'zstd' },
    { value: 'gzip', label: 'gzip' },
    { value: 'none', label: t('deployment.form.compressionNone') },
  ];

  React.useEffect(() => {
    if (open) {
      setDraft(draftFor(workflow, defaultProfileId));
    }
  }, [defaultProfileId, open, workflow]);

  const update = <Key extends keyof WorkflowDraft>(key: Key, value: WorkflowDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!validDraft(draft) || !admissionsEnabled) return;
    try {
      const input = workflowInput(draft);
      if (workflow) {
        await updateWorkflow(workflow.id, { ...input, expectedRevision: workflow.revision });
      } else {
        await createWorkflow(input);
      }
      onOpenChange(false);
    } catch (error) {
      const message = getErrorMessage(error);
      if (useDeploymentStore.getState().error !== message) {
        addToast(`${t('deployment.error.title')}\n${localizedStoreError(message, t)}`, 'error', 6_000);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(48rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-4">
          <DialogTitle>
            {t(workflow ? 'deployment.form.editTitle' : 'deployment.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('deployment.form.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={(event) => void submit(event)}
        >
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="px-4 pb-1">
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-name">{t('deployment.form.name')}</FieldLabel>
                  <Input
                    id="deployment-name"
                    autoFocus
                    value={draft.name}
                    onChange={(event) => update('name', event.target.value)}
                    required
                  />
                  <FieldDescription>{t('deployment.form.retentionHint')}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-profile">{t('deployment.form.profile')}</FieldLabel>
                  <Select
                    items={profileOptions}
                    value={draft.profileId}
                    onValueChange={(value) => update('profileId', value ?? '')}
                  >
                    <SelectTrigger id="deployment-profile" aria-label={t('deployment.form.profile')}>
                      <SelectValue placeholder={t('deployment.form.profile')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {profileOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="deployment-source">{t('deployment.form.sourceDirectory')}</FieldLabel>
                <Input
                  id="deployment-source"
                  value={draft.sourceDirectory}
                  onChange={(event) => update('sourceDirectory', event.target.value)}
                  placeholder="/absolute/project/root"
                  required
                />
                <FieldDescription>{t('deployment.form.sourceHint')}</FieldDescription>
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-build-context">{t('deployment.form.buildContext')}</FieldLabel>
                  <Input
                    id="deployment-build-context"
                    value={draft.buildContext}
                    onChange={(event) => update('buildContext', event.target.value)}
                    required
                  />
                  <FieldDescription>{t('deployment.form.buildPathHint')}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-dockerfile">{t('deployment.form.dockerfile')}</FieldLabel>
                  <Input
                    id="deployment-dockerfile"
                    value={draft.dockerfile}
                    onChange={(event) => update('dockerfile', event.target.value)}
                    required
                  />
                  <FieldDescription>{t('deployment.form.buildPathHint')}</FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="deployment-image-repository">{t('deployment.form.imageRepository')}</FieldLabel>
                <Input
                  id="deployment-image-repository"
                  value={draft.imageRepository}
                  onChange={(event) => update('imageRepository', event.target.value)}
                  placeholder="registry.example.com/team/app"
                  required
                />
                <FieldDescription>{t('deployment.form.imageRepositoryHint')}</FieldDescription>
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-platform">{t('deployment.form.platform')}</FieldLabel>
                  <Select
                    items={PLATFORM_OPTIONS}
                    value={draft.platform}
                    onValueChange={(value) => update('platform', (value ?? 'linux/amd64') as WorkflowDraft['platform'])}
                  >
                    <SelectTrigger id="deployment-platform" aria-label={t('deployment.form.platform')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {PLATFORM_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-compression">{t('deployment.form.compression')}</FieldLabel>
                  <Select
                    items={compressionOptions}
                    value={draft.compression}
                    onValueChange={(value) => update('compression', (value ?? 'zstd') as WorkflowDraft['compression'])}
                  >
                    <SelectTrigger id="deployment-compression" aria-label={t('deployment.form.compression')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {compressionOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="deployment-root">{t('deployment.form.remoteRoot')}</FieldLabel>
                <Input
                  id="deployment-root"
                  value={draft.remoteRoot}
                  onChange={(event) => update('remoteRoot', event.target.value)}
                  required
                />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-compose-project">{t('deployment.form.composeProject')}</FieldLabel>
                  <Input
                    id="deployment-compose-project"
                    value={draft.composeProject}
                    onChange={(event) => update('composeProject', event.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-retention">{t('deployment.form.retention')}</FieldLabel>
                  <Input
                    id="deployment-retention"
                    type="number"
                    min={1}
                    max={20}
                    value={draft.releasesToKeep}
                    onChange={(event) => update('releasesToKeep', event.target.value)}
                    required
                  />
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-compose-files">{t('deployment.form.composeFiles')}</FieldLabel>
                  <Textarea
                    id="deployment-compose-files"
                    value={draft.composeFiles}
                    onChange={(event) => update('composeFiles', event.target.value)}
                    rows={3}
                    required
                  />
                  <FieldDescription>{t('deployment.form.listHint')}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-services">{t('deployment.form.services')}</FieldLabel>
                  <Textarea
                    id="deployment-services"
                    value={draft.services}
                    onChange={(event) => update('services', event.target.value)}
                    rows={3}
                  />
                  <FieldDescription>{t('deployment.form.servicesHint')}</FieldDescription>
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="deployment-health-path">{t('deployment.form.healthPath')}</FieldLabel>
                  <Input
                    id="deployment-health-path"
                    value={draft.healthPath}
                    onChange={(event) => update('healthPath', event.target.value)}
                    placeholder="/healthz"
                  />
                </Field>
                <Field data-disabled={!draft.healthPath}>
                  <FieldLabel htmlFor="deployment-health-status">{t('deployment.form.healthStatus')}</FieldLabel>
                  <Input
                    id="deployment-health-status"
                    type="number"
                    min={100}
                    max={599}
                    disabled={!draft.healthPath}
                    value={draft.healthStatus}
                    onChange={(event) => update('healthStatus', event.target.value)}
                  />
                </Field>
                <Field data-disabled={!draft.healthPath}>
                  <FieldLabel htmlFor="deployment-health-timeout">{t('deployment.form.healthTimeout')}</FieldLabel>
                  <Input
                    id="deployment-health-timeout"
                    type="number"
                    min={1}
                    max={300}
                    disabled={!draft.healthPath}
                    value={draft.healthTimeout}
                    onChange={(event) => update('healthTimeout', event.target.value)}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field className="flex-row items-center gap-2">
                  <Checkbox
                    id="deployment-pull"
                    checked={draft.pullBeforeUp}
                    onCheckedChange={(checked) => update('pullBeforeUp', checked)}
                  />
                  <FieldLabel htmlFor="deployment-pull">{t('deployment.form.pullBeforeUp')}</FieldLabel>
                </Field>
                <Field className="flex-row items-center gap-2">
                  <Checkbox
                    id="deployment-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(checked) => update('enabled', checked)}
                  />
                  <FieldLabel htmlFor="deployment-enabled">{t('deployment.form.enabled')}</FieldLabel>
                </Field>
                <Field
                  className="flex-row items-center gap-2"
                  data-disabled={!draft.healthPath}
                >
                  <Checkbox
                    id="deployment-nginx-reload"
                    checked={draft.reloadNginxAfterHealthy}
                    disabled={!draft.healthPath}
                    onCheckedChange={(checked) => update('reloadNginxAfterHealthy', checked)}
                  />
                  <FieldLabel htmlFor="deployment-nginx-reload">
                    {t('deployment.form.reloadNginxAfterHealthy')}
                  </FieldLabel>
                </Field>
              </div>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 p-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!admissionsEnabled || !validDraft(draft) || saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function checkVariant(check: DeploymentPreflightCheckSummary): 'default' | 'secondary' | 'destructive' {
  if (check.outcome === 'blocked') return 'destructive';
  if (check.outcome === 'warning') return 'secondary';
  return 'default';
}

function profileMatchesTarget(
  profile: ConnectionProfile | undefined,
  target: DeploymentTargetIdentitySnapshot,
): boolean {
  if (
    !profile
    || profile.id !== target.profileId
    || profile.updatedAt !== target.profileUpdatedAt
    || profile.host !== target.host
    || profile.port !== target.port
    || profile.username !== target.username
    || profile.authMethod !== target.authMethod
  ) {
    return false;
  }
  const jump = profile.jumpHost;
  return target.jumpHost === null
    ? !jump
    : Boolean(
      jump
      && jump.host === target.jumpHost.host
      && jump.port === target.jumpHost.port
      && jump.username === target.jumpHost.username
      && jump.authMethod === target.jumpHost.authMethod,
    );
}

function localizedStoreError(
  error: string,
  t: (key: LocaleKey, values?: Record<string, string | number>) => string,
): string {
  if (error.includes('REVISION_CONFLICT')) return t('deployment.error.revisionConflict');
  if (error.includes('DEPLOYMENT_WORKFLOW_HAS_RUNS')) return t('deployment.error.hasRuns');
  return t('deployment.error.description');
}

function CheckIcon({ outcome }: { outcome: DeploymentPreflightCheckSummary['outcome'] }): React.JSX.Element {
  if (outcome === 'blocked') return <XCircleIcon aria-hidden />;
  if (outcome === 'warning') return <ShieldAlertIcon aria-hidden />;
  return <CheckCircle2Icon aria-hidden />;
}

const DeploymentCenter: React.FC = () => {
  const { t, locale } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const workflows = useDeploymentStore((state) => state.workflows);
  const runtimeCapabilities = useDeploymentStore((state) => state.runtimeCapabilities);
  const runs = useDeploymentStore((state) => state.runs);
  const selectedWorkflowId = useDeploymentStore((state) => state.selectedWorkflowId);
  const profileFilterId = useDeploymentStore((state) => state.profileFilterId);
  const initialized = useDeploymentStore((state) => state.initialized);
  const loading = useDeploymentStore((state) => state.loading);
  const saving = useDeploymentStore((state) => state.saving);
  const error = useDeploymentStore((state) => state.error);
  const recoveryCandidates = useDeploymentStore((state) => state.recoveryCandidates);
  const recoveryDiscoveryFailed = useDeploymentStore((state) => state.recoveryDiscoveryFailed);
  const reconciliationPhase = useDeploymentStore((state) => state.reconciliationPhase);
  const reconciliationRunId = useDeploymentStore((state) => state.reconciliationRunId);
  const reconciliationResults = useDeploymentStore((state) => state.reconciliationResults);
  const recoveredApprovedBinding = useDeploymentStore((state) => state.recoveredApprovedBinding);
  const artifactBuildPhase = useDeploymentStore((state) => state.artifactBuildPhase);
  const artifactBuildProgress = useDeploymentStore((state) => state.artifactBuildProgress);
  const artifactBuildResult = useDeploymentStore((state) => state.artifactBuildResult);
  const preflightPhase = useDeploymentStore((state) => state.preflightPhase);
  const preflightResult = useDeploymentStore((state) => state.preflightResult);
  const plan = useDeploymentStore((state) => state.plan);
  const approvalPhase = useDeploymentStore((state) => state.approvalPhase);
  const artifactTransferPhase = useDeploymentStore((state) => state.artifactTransferPhase);
  const artifactTransferProgress = useDeploymentStore((state) => state.artifactTransferProgress);
  const artifactTransferResult = useDeploymentStore((state) => state.artifactTransferResult);
  const remoteRunnerPhase = useDeploymentStore((state) => state.remoteRunnerPhase);
  const remoteRunnerProgress = useDeploymentStore((state) => state.remoteRunnerProgress);
  const remoteRunnerLog = useDeploymentStore((state) => state.remoteRunnerLog);
  const remoteRunnerResult = useDeploymentStore((state) => state.remoteRunnerResult);
  const navigationTarget = useDeploymentStore((state) => state.navigationTarget);
  const loadWorkflows = useDeploymentStore((state) => state.loadWorkflows);
  const selectWorkflow = useDeploymentStore((state) => state.selectWorkflow);
  const setProfileFilter = useDeploymentStore((state) => state.setProfileFilter);
  const deleteWorkflow = useDeploymentStore((state) => state.deleteWorkflow);
  const buildArtifact = useDeploymentStore((state) => state.buildArtifact);
  const cancelArtifactBuild = useDeploymentStore((state) => state.cancelArtifactBuild);
  const runPreflight = useDeploymentStore((state) => state.runPreflight);
  const cancelPreflight = useDeploymentStore((state) => state.cancelPreflight);
  const createPlan = useDeploymentStore((state) => state.createPlan);
  const requestApproval = useDeploymentStore((state) => state.requestApproval);
  const approvePlan = useDeploymentStore((state) => state.approvePlan);
  const rejectPlan = useDeploymentStore((state) => state.rejectPlan);
  const transferArtifact = useDeploymentStore((state) => state.transferArtifact);
  const cancelArtifactTransfer = useDeploymentStore((state) => state.cancelArtifactTransfer);
  const runRemote = useDeploymentStore((state) => state.runRemote);
  const cancelRemoteRunner = useDeploymentStore((state) => state.cancelRemoteRunner);
  const reconcileRun = useDeploymentStore((state) => state.reconcileRun);
  const stopReconciliationObservation = useDeploymentStore((state) => state.stopReconciliationObservation);
  const prepareNewPlan = useDeploymentStore((state) => state.prepareNewPlan);
  const clearError = useDeploymentStore((state) => state.clearError);
  const addToast = useToastStore((state) => state.addToast);
  const errorToastRef = React.useRef<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DeploymentWorkflowRecord | null>(null);
  const [deleting, setDeleting] = React.useState<DeploymentWorkflowRecord | null>(null);
  const [approvalOpen, setApprovalOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);

  React.useEffect(() => {
    if (!initialized && !loading) void loadWorkflows().catch(() => undefined);
  }, [initialized, loadWorkflows, loading]);

  React.useEffect(() => {
    if (!error) {
      errorToastRef.current = null;
      return;
    }
    if (errorToastRef.current === error) return;
    errorToastRef.current = error;
    addToast(`${t('deployment.error.title')}\n${localizedStoreError(error, t)}`, 'error', 6_000);
    clearError();
  }, [addToast, clearError, error, t]);

  const visibleWorkflows = React.useMemo(
    () => profileFilterId
      ? workflows.filter((workflow) => workflow.connectionProfileId === profileFilterId)
      : workflows,
    [profileFilterId, workflows],
  );
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;

  React.useEffect(() => {
    if (selectedWorkflow && (!profileFilterId || selectedWorkflow.connectionProfileId === profileFilterId)) return;
    selectWorkflow(visibleWorkflows[0]?.id ?? null);
  }, [profileFilterId, selectWorkflow, selectedWorkflow, visibleWorkflows]);

  React.useEffect(() => {
    if (navigationTarget !== 'newRelease' || !selectedWorkflow) return;
    window.requestAnimationFrame(() => {
      document.getElementById('deployment-release-workflow')?.focus();
      useDeploymentStore.setState({ navigationTarget: null });
    });
  }, [navigationTarget, selectedWorkflow]);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (): void => {
    if (!selectedWorkflow) return;
    setEditing(selectedWorkflow);
    setDialogOpen(true);
  };
  const startArtifactBuild = async (): Promise<void> => {
    if (!selectedWorkflow) return;
    await buildArtifact(selectedWorkflow.id, selectedWorkflow.revision).catch(() => undefined);
  };
  const startPreflight = async (): Promise<void> => {
    if (!selectedWorkflow) return;
    await runPreflight({
      workflowId: selectedWorkflow.id,
      expectedRevision: selectedWorkflow.revision,
      ttlSeconds: 600,
      timeoutMs: 30_000,
    }).catch(() => undefined);
  };
  const artifactReady = Boolean(
    artifactBuildResult?.status === 'succeeded'
    && artifactBuildResult.artifactReference
    && artifactBuildResult.manifest
    && selectedWorkflow
    && artifactBuildResult.workflowId === selectedWorkflow.id
    && artifactBuildResult.workflowRevision === selectedWorkflow.revision,
  );
  const planExpired = Boolean(plan && Date.now() >= plan.expiresAt);
  const artifactInputChanged = Boolean(
    preflightResult
    && preflightResult.artifactReference !== artifactBuildResult?.artifactReference,
  );
  const targetInputChanged = Boolean(
    plan
    && !profileMatchesTarget(
      profiles.find((profile) => profile.id === plan.approvalSummary.frozen.target.profileId),
      plan.approvalSummary.frozen.target,
    ),
  );
  const inputsChanged = Boolean(
    selectedWorkflow
    && (
      (preflightResult?.workflowRevision != null
        && preflightResult.workflowRevision !== selectedWorkflow.revision)
      || (plan && plan.approvalSummary.workflowRevision !== selectedWorkflow.revision)
      || artifactInputChanged
      || targetInputChanged
    ),
  );
  const planApproved = Boolean(plan?.status === 'approved' && !planExpired && !inputsChanged);
  const transferReady = Boolean(
    planApproved
    && artifactTransferResult?.status === 'succeeded'
    && artifactTransferResult.remoteStagingIdentity
    && artifactTransferResult.planId === plan?.planId
    && artifactTransferResult.releaseId === artifactBuildResult?.releaseId
    && artifactTransferResult.remoteDigestSha256 === artifactBuildResult?.artifactDigestSha256,
  );
  const recoveryBlocked = recoveryDiscoveryFailed
    || recoveryCandidates.length > 0
    || reconciliationPhase !== 'idle';
  const admissionsEnabled = runtimeCapabilities?.admissionsEnabled === true;
  const actionBlocked = recoveryBlocked || !admissionsEnabled;
  const recoveredApprovalReady = Boolean(
    recoveredApprovedBinding
    && planApproved
    && plan?.planId === recoveredApprovedBinding.planId,
  );
  const runnerReady = transferReady || recoveredApprovalReady;
  const recoveryResults = Object.values(reconciliationResults);
  const rollbackSteps = new Set([
    'composeUp',
    'verifyHealth',
    'validateNginx',
    'reloadNginx',
    'reverifyHealth',
    'activateRelease',
    'restoreRelease',
    'recordResult',
  ]);
  const stopRequiresRollback = Boolean(
    remoteRunnerProgress && rollbackSteps.has(remoteRunnerProgress.step),
  );
  const profileFilterOptions = [
    { value: 'all', label: t('deployment.filter.allProfiles') },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];

  return (
    <WorkbenchPage>
      <WorkbenchPageHeader
        icon={CloudUploadIcon}
        title={t('deployment.title')}
        description={t('deployment.description')}
        actions={(
          <>
            <Select
              items={profileFilterOptions}
              value={profileFilterId ?? 'all'}
              onValueChange={(value) => setProfileFilter(value === 'all' ? null : value ?? null)}
            >
              <SelectTrigger size="sm" className="w-48" aria-label={t('deployment.filter.profile')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {profileFilterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon data-icon="inline-start" />
              {t('deployment.history.title')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadWorkflows().catch(() => undefined)} disabled={loading}>
              {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t('common.refresh')}
            </Button>
            <Button size="sm" onClick={openCreate} disabled={profiles.length === 0 || actionBlocked}>
              <PlusIcon data-icon="inline-start" />
              {t('deployment.new')}
            </Button>
          </>
        )}
      />
      <WorkbenchPageContent className="min-h-0 flex-1 overflow-y-auto @min-[64rem]:overflow-hidden">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {artifactBuildPhase !== 'idle'
            ? t('deployment.announce.building')
            : artifactTransferPhase !== 'idle'
              ? t('deployment.announce.uploading')
              : remoteRunnerPhase !== 'idle'
                ? t('deployment.announce.executing')
                : reconciliationPhase !== 'idle'
                  ? t('deployment.announce.reconciling')
                  : remoteRunnerResult
                    ? t(`deployment.execute.status.${remoteRunnerResult.status}` as LocaleKey)
                    : ''}
        </p>
        {runtimeCapabilities && !runtimeCapabilities.admissionsEnabled && (
          <Alert variant="warning">
            <ShieldAlertIcon />
            <AlertTitle>{t('deployment.rollout.disabledTitle')}</AlertTitle>
            <AlertDescription>
              {t('deployment.rollout.disabledDescription', { flag: runtimeCapabilities.flagName })}
            </AlertDescription>
          </Alert>
        )}
        {(recoveryDiscoveryFailed || recoveryCandidates.length > 0 || recoveryResults.length > 0) && (
          <Card id="deployment-recovery-card" tabIndex={-1} variant="outline" radius="compact">
            <CardHeader>
              <CardTitle>{t('deployment.recovery.title')}</CardTitle>
              <CardDescription>{t('deployment.recovery.description')}</CardDescription>
              <CardAction>
                <Badge variant={recoveryCandidates.length > 0 ? 'destructive' : 'secondary'}>
                  {t('deployment.recovery.count', { count: recoveryCandidates.length })}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {recoveryDiscoveryFailed && (
                <Alert variant="destructiveSubtle">
                  <AlertCircleIcon />
                  <AlertTitle>{t('deployment.recovery.discoveryFailed')}</AlertTitle>
                  <AlertDescription>{t('deployment.recovery.discoveryFailedDescription')}</AlertDescription>
                </Alert>
              )}
              {recoveryCandidates.map((candidate) => {
                const observing = reconciliationRunId === candidate.runId
                  && reconciliationPhase !== 'idle';
                return (
                  <Alert
                    key={candidate.runId}
                    variant={candidate.status === 'state_unknown' ? 'destructiveSubtle' : 'warning'}
                  >
                    {observing ? <Spinner /> : <ShieldAlertIcon />}
                    <AlertTitle>
                      {candidate.runId} · {t(`deployment.plan.status.${candidate.status}` as LocaleKey)}
                    </AlertTitle>
                    <AlertDescription>
                      {t('deployment.recovery.candidateDescription', {
                        sequence: candidate.lastEventSequence,
                      })}
                      {' '}{t('deployment.recovery.evidenceRequired')}
                    </AlertDescription>
                    <AlertAction>
                      {observing ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={reconciliationPhase === 'stopping'}
                          onClick={() => void stopReconciliationObservation().catch(() => undefined)}
                        >
                          {reconciliationPhase === 'stopping'
                            ? <Spinner data-icon="inline-start" />
                            : <SquareIcon data-icon="inline-start" />}
                          {t('deployment.recovery.stopObservation')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={reconciliationPhase !== 'idle'}
                          onClick={() => void reconcileRun(candidate.runId).catch(() => undefined)}
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          {t('deployment.recovery.reconcile')}
                        </Button>
                      )}
                    </AlertAction>
                  </Alert>
                );
              })}
              {recoveryResults.map((result) => (
                <Alert
                  key={`${result.runId}:${result.operationId}`}
                  variant={result.outcome === 'targetHealthy' || result.outcome === 'noSideEffects'
                    ? 'default'
                    : result.outcome === 'rollbackHealthy'
                        || result.outcome === 'stillRunning'
                        || result.outcome === 'observationStopped'
                      ? 'warning'
                      : 'destructive'}
                >
                  {result.outcome === 'targetHealthy' || result.outcome === 'noSideEffects'
                    ? <CheckCircle2Icon />
                    : result.outcome === 'stateUnknown'
                      ? <AlertCircleIcon />
                      : <ShieldAlertIcon />}
                  <AlertTitle>{t(`deployment.recovery.outcome.${result.outcome}` as LocaleKey)}</AlertTitle>
                  <AlertDescription>
                    <span className="block">{t(`deployment.recovery.outcomeDescription.${result.outcome}` as LocaleKey)}</span>
                    <span className="mt-1 block text-xs">
                      {t('deployment.recovery.evidenceSummary', {
                        sequence: result.evidence.remoteSequence ?? 0,
                        current: result.evidence.currentReleaseId ?? t('deployment.summary.none'),
                        previous: result.evidence.previousReleaseId ?? t('deployment.summary.none'),
                      })}
                    </span>
                  </AlertDescription>
                </Alert>
              ))}
            </CardContent>
            {recoveryBlocked && (
              <CardFooter>
                <p className="text-xs text-muted-foreground">{t('deployment.recovery.gate')}</p>
              </CardFooter>
            )}
          </Card>
        )}
        {!initialized && loading ? (
          <PanelLoadingState label={t('deployment.loading')} />
        ) : profiles.length === 0 ? (
          <EmptyState
            className="min-h-80"
            title={t('deployment.noProfiles')}
            description={t('deployment.noProfilesDescription')}
            icon={<ServerCogIcon />}
          />
        ) : visibleWorkflows.length === 0 ? (
          <EmptyState
            className="min-h-80"
            title={t('deployment.empty')}
            description={t('deployment.emptyDescription')}
            icon={<CloudUploadIcon />}
            action={<Button onClick={openCreate} disabled={!admissionsEnabled}><PlusIcon data-icon="inline-start" />{t('deployment.new')}</Button>}
          />
        ) : (
          <div className="grid min-h-0 flex-1 items-stretch gap-4 @min-[64rem]:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
            <Card className="min-h-0 @min-[64rem]:h-full" size="sm" variant="outline" radius="compact">
              <CardHeader>
                <CardTitle>{t('deployment.workflows')}</CardTitle>
                <CardDescription>{t('deployment.workflowCount', { count: visibleWorkflows.length })}</CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 p-0">
                <ScrollArea className="h-full max-h-72 @min-[64rem]:max-h-none">
                  <div className="flex flex-col gap-1 px-2">
                    {visibleWorkflows.map((workflow) => {
                      const latestRun = runs.find((run) => run.workflowId === workflow.id);
                      const currentRelease = latestRun?.status === 'succeeded'
                        ? latestRun.approvalSummary.frozen.targetRelease.releaseId
                        : null;
                      return (
                      <Button
                        key={workflow.id}
                        variant={workflow.id === selectedWorkflowId ? 'secondary' : 'ghost'}
                        className="h-auto justify-start px-2 py-2 text-left"
                        aria-current={workflow.id === selectedWorkflowId ? 'page' : undefined}
                        onClick={() => selectWorkflow(workflow.id)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{workflow.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {workflow.definition.compose.projectName} · r{workflow.revision}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {t('deployment.workflow.currentVersion')}: {currentRelease ?? t('deployment.workflow.currentUnknown')}
                            {' · '}{t('deployment.workflow.latestResult')}: {latestRun
                              ? t(`deployment.plan.status.${latestRun.status}` as LocaleKey)
                              : t('deployment.workflow.noRuns')}
                          </span>
                        </span>
                        {!workflow.enabled && <Badge variant="outline">{t('deployment.disabled')}</Badge>}
                      </Button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {selectedWorkflow && (
              <ScrollArea className="-mr-4 min-h-0 min-w-0 @min-[64rem]:h-full">
                <div id="deployment-release-workflow" tabIndex={-1} className="flex flex-col gap-3 pr-4 pb-2 outline-none">
                  <Card size="sm" variant="outline" radius="compact">
                    <CardHeader>
                      <CardTitle>{selectedWorkflow.name}</CardTitle>
                      <CardDescription>
                        {selectedWorkflow.definition.sourceDirectory} → {selectedWorkflow.definition.target.remoteRoot}
                      </CardDescription>
                      <CardAction className="flex gap-1">
                        <Button variant="ghost" size="icon" aria-label={t('common.edit')} onClick={openEdit} disabled={!admissionsEnabled}>
                          <PencilIcon />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={t('common.delete')} onClick={() => setDeleting(selectedWorkflow)} disabled={!admissionsEnabled}>
                          <Trash2Icon />
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                      <div><span className="text-muted-foreground">{t('deployment.summary.profile')}</span><div>{profiles.find((profile) => profile.id === selectedWorkflow.connectionProfileId)?.name ?? selectedWorkflow.connectionProfileId}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.compose')}</span><div>{selectedWorkflow.definition.compose.projectName}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.image')}</span><div>{selectedWorkflow.definition.build.imageRepository}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.platform')}</span><div>{selectedWorkflow.definition.build.platform}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.files')}</span><div>{selectedWorkflow.definition.compose.files.join(', ')}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.services')}</span><div>{selectedWorkflow.definition.compose.services.join(', ') || t('deployment.summary.allServices')}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.retention')}</span><div>{t('deployment.summary.retentionDisabled', { count: selectedWorkflow.definition.releasesToKeep })}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.health')}</span><div>{selectedWorkflow.definition.healthCheck?.path ?? t('deployment.summary.none')}</div></div>
                      <div><span className="text-muted-foreground">{t('deployment.summary.nginx')}</span><div>{selectedWorkflow.definition.reloadNginxAfterHealthy ? t('deployment.summary.enabled') : t('deployment.summary.disabled')}</div></div>
                    </CardContent>
                  </Card>

                  <Card size="sm" variant="outline" radius="compact">
                    <CardHeader className="gap-x-4">
                      <CardTitle>{t('deployment.artifact.title')}</CardTitle>
                      <CardDescription>{t('deployment.artifact.description')}</CardDescription>
                      <CardAction>
                        {artifactBuildPhase === 'running' || artifactBuildPhase === 'cancelling' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void cancelArtifactBuild().catch(() => undefined)}
                            disabled={artifactBuildPhase === 'cancelling'}
                          >
                            <SquareIcon data-icon="inline-start" />
                            {t('common.cancel')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => void startArtifactBuild()}
                            disabled={actionBlocked || !selectedWorkflow.enabled || artifactBuildPhase !== 'idle' || preflightPhase !== 'idle'}
                          >
                            <PackageIcon data-icon="inline-start" />
                            {t(artifactReady ? 'deployment.artifact.rebuild' : 'deployment.artifact.build')}
                          </Button>
                        )}
                      </CardAction>
                    </CardHeader>
                    {(artifactBuildPhase !== 'idle' || artifactBuildResult?.failure || (artifactReady && artifactBuildResult?.manifest)) && (
                    <CardContent className="flex flex-col gap-3">
                      {artifactBuildPhase !== 'idle' && (
                        <Alert role="status">
                          <Spinner role="presentation" aria-hidden />
                          <AlertTitle>
                            {t(artifactBuildPhase === 'cancelling'
                              ? 'deployment.artifact.cancelling'
                              : 'deployment.artifact.running')}
                          </AlertTitle>
                          <AlertDescription>
                            {artifactBuildProgress
                              ? t(`deployment.artifact.step.${artifactBuildProgress.step}` as LocaleKey)
                              : t('deployment.artifact.snapshotting')}
                            {artifactBuildProgress?.completedBytes != null
                              ? ` · ${formatBytes(artifactBuildProgress.completedBytes)}`
                              : ''}
                          </AlertDescription>
                        </Alert>
                      )}
                      {artifactBuildResult?.failure && (
                        <Alert variant="destructive">
                          <AlertCircleIcon />
                          <AlertTitle>{t(`deployment.artifact.status.${artifactBuildResult.status}` as LocaleKey)}</AlertTitle>
                          <AlertDescription>
                            {t(`deployment.artifact.failure.${artifactBuildResult.failure.category}` as LocaleKey)}
                          </AlertDescription>
                        </Alert>
                      )}
                      {artifactReady && artifactBuildResult?.manifest && (
                        <>
                          <Alert>
                            <CheckCircle2Icon />
                            <AlertTitle>{t('deployment.artifact.verified')}</AlertTitle>
                            <AlertDescription>
                              {artifactBuildResult.reused
                                ? t('deployment.artifact.reused')
                                : t('deployment.artifact.created')}
                            </AlertDescription>
                          </Alert>
                          <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                            <div><span className="text-muted-foreground">{t('deployment.artifact.releaseId')}</span><div className="font-mono text-xs">{artifactBuildResult.manifest.releaseId}</div></div>
                            <div><span className="text-muted-foreground">{t('deployment.artifact.image')}</span><div className="break-all">{artifactBuildResult.manifest.image.repository}:{artifactBuildResult.manifest.image.tag}</div></div>
                            <div><span className="text-muted-foreground">{t('deployment.artifact.platform')}</span><div>{artifactBuildResult.manifest.platform}</div></div>
                            <div><span className="text-muted-foreground">{t('deployment.artifact.archive')}</span><div>{artifactBuildResult.manifest.archive.fileName} · {formatBytes(artifactBuildResult.manifest.archive.bytes)}</div></div>
                            <div><span className="text-muted-foreground">{t('deployment.artifact.digest')}</span><div className="break-all font-mono text-xs">{artifactBuildResult.manifest.archive.sha256}</div></div>
                            <div><span className="text-muted-foreground">{t('deployment.artifact.manifestDigest')}</span><div className="break-all font-mono text-xs">{artifactBuildResult.manifest.manifestDigestSha256}</div></div>
                          </div>
                        </>
                      )}
                    </CardContent>
                    )}
                  </Card>

                  <Card size="sm" variant="outline" radius="compact">
                    <CardHeader className="gap-x-4">
                      <CardTitle>{t('deployment.preflight.title')}</CardTitle>
                      <CardDescription>{t('deployment.preflight.description')}</CardDescription>
                      <CardAction>
                        {preflightPhase !== 'idle' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void cancelPreflight().catch(() => undefined)}
                            disabled={preflightPhase === 'cancelling'}
                          >
                            <SquareIcon data-icon="inline-start" />
                            {t('common.cancel')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => void startPreflight()}
                            disabled={actionBlocked || !selectedWorkflow.enabled || !artifactReady || artifactBuildPhase !== 'idle'}
                          >
                            <ShieldAlertIcon data-icon="inline-start" />
                            {t('deployment.preflight.run')}
                          </Button>
                        )}
                      </CardAction>
                    </CardHeader>
                    {(!artifactReady || preflightPhase !== 'idle' || preflightResult?.failure || (preflightResult && preflightResult.checks.length > 0) || preflightResult?.remoteRoot) && (
                    <CardContent className="flex flex-col gap-3">
                      {!artifactReady && (
                        <Alert variant="warning">
                          <Clock3Icon />
                          <AlertTitle>{t('deployment.preflight.artifactRequired')}</AlertTitle>
                          <AlertDescription>{t('deployment.preflight.artifactRequiredDescription')}</AlertDescription>
                        </Alert>
                      )}
                      {preflightPhase !== 'idle' && (
                        <Alert role="status">
                          <Spinner role="presentation" aria-hidden />
                          <AlertTitle>{t(preflightPhase === 'cancelling' ? 'deployment.preflight.cancelling' : 'deployment.preflight.running')}</AlertTitle>
                          <AlertDescription>{t('deployment.preflight.progress')}</AlertDescription>
                        </Alert>
                      )}
                      {preflightResult?.failure && (
                        <Alert variant="destructive">
                          <AlertCircleIcon />
                          <AlertTitle>{t(`deployment.preflight.status.${preflightResult.status}` as LocaleKey)}</AlertTitle>
                          <AlertDescription>
                            {t(`deployment.preflight.failure.${preflightResult.failure.category}` as LocaleKey)}
                          </AlertDescription>
                        </Alert>
                      )}
                      {preflightResult && preflightResult.checks.length > 0 && (
                        <div className="flex flex-col gap-2" aria-label={t('deployment.preflight.checks')}>
                          {preflightResult.checks.map((item) => (
                            <div key={item.code} className="flex items-start gap-2 rounded-lg border p-2">
                              <CheckIcon outcome={item.outcome} />
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium">{t(`deployment.preflight.check.${item.code}` as LocaleKey)}</div>
                                <div className="text-xs text-muted-foreground">
                                  {t(`deployment.preflight.checkDescription.${item.code}` as LocaleKey)}
                                </div>
                              </div>
                              <Badge variant={checkVariant(item)}>{t(`deployment.preflight.outcome.${item.outcome}`)}</Badge>
                            </div>
                          ))}
                        </div>
                      )}
                      {preflightResult?.remoteRoot && (
                        <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
                          <div><span className="text-muted-foreground">{t('deployment.preflight.platform')}</span><div>{preflightResult.server?.os} {preflightResult.server?.architecture}</div></div>
                          <div><span className="text-muted-foreground">{t('deployment.preflight.disk')}</span><div>{formatBytes(preflightResult.remoteRoot.availableBytes)}</div></div>
                          <div><span className="text-muted-foreground">{t('deployment.preflight.currentRelease')}</span><div>{preflightResult.currentRelease?.releaseId ?? t('deployment.summary.none')}</div></div>
                        </div>
                      )}
                    </CardContent>
                    )}
                  </Card>

                  {(preflightResult?.status === 'passed' || plan) && (
                    <Card size="sm" variant="outline" radius="compact">
                      <CardHeader className="gap-x-4">
                        <CardTitle>{t('deployment.plan.title')}</CardTitle>
                        <CardDescription>{t('deployment.plan.description')}</CardDescription>
                        {(!plan || plan.status === 'planned' || plan.status === 'awaiting_approval') && (
                          <CardAction>
                            {!plan && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void createPlan().catch(() => undefined)}
                                disabled={actionBlocked || saving || inputsChanged}
                              >
                                {saving && <Spinner data-icon="inline-start" />}
                                {t('deployment.plan.create')}
                              </Button>
                            )}
                            {plan?.status === 'planned' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void requestApproval().then(() => setApprovalOpen(true)).catch(() => undefined)}
                                disabled={actionBlocked || approvalPhase !== 'idle' || planExpired || inputsChanged}
                              >
                                {approvalPhase !== 'idle' && <Spinner data-icon="inline-start" />}
                                {t('deployment.plan.requestApproval')}
                              </Button>
                            )}
                            {plan?.status === 'awaiting_approval' && (
                              <Button
                                size="sm"
                                onClick={() => setApprovalOpen(true)}
                                disabled={actionBlocked || approvalPhase !== 'idle' || planExpired || inputsChanged}
                              >
                                {t('deployment.plan.reviewApproval')}
                              </Button>
                            )}
                          </CardAction>
                        )}
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        {(inputsChanged || planExpired) && (
                          <Alert variant="warning">
                            <Clock3Icon />
                            <AlertTitle>{t(planExpired ? 'deployment.plan.expired' : 'deployment.plan.inputsChanged')}</AlertTitle>
                            <AlertDescription>{t('deployment.plan.refreshRequired')}</AlertDescription>
                            <AlertAction>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => prepareNewPlan(selectedWorkflow.id)}
                              >
                                {t('deployment.history.createNewPlan')}
                              </Button>
                            </AlertAction>
                          </Alert>
                        )}
                        {plan ? (
                          <div className="flex flex-col gap-4 text-sm">
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                              <div><span className="text-muted-foreground">{t('deployment.plan.id')}</span><div className="break-all font-mono text-xs">{plan.planId}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.runId')}</span><div className="font-mono text-xs">{plan.runId} · r{plan.runRevision}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.status')}</span><div><Badge variant="outline">{t(`deployment.plan.status.${plan.status}` as LocaleKey)}</Badge></div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.expires')}</span><div>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(plan.expiresAt)}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.source')}</span><div className="break-all font-mono text-xs">{plan.approvalSummary.frozen.sourceRevision.revision}{plan.approvalSummary.frozen.sourceRevision.dirty ? ` · ${t('deployment.plan.dirty')}` : ''}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.target')}</span><div>{plan.approvalSummary.frozen.target.username}@{plan.approvalSummary.frozen.target.host}:{plan.approvalSummary.frozen.target.port}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.remoteRoot')}</span><div className="break-all">{plan.approvalSummary.remoteRoot}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.compose')}</span><div>{plan.approvalSummary.composeProject} · {plan.approvalSummary.composeFiles.join(', ')}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.services')}</span><div>{plan.approvalSummary.services.join(', ') || t('deployment.summary.allServices')}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.currentRelease')}</span><div className="font-mono text-xs">{plan.approvalSummary.frozen.currentRelease?.releaseId ?? t('deployment.summary.none')}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.targetRelease')}</span><div className="font-mono text-xs">{plan.approvalSummary.frozen.targetRelease.releaseId}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.plan.rollbackRelease')}</span><div className="font-mono text-xs">{plan.approvalSummary.frozen.rollbackRelease?.releaseId ?? t('deployment.summary.none')}</div></div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t('deployment.plan.actions')}</span>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {plan.approvalSummary.actions.map((action) => (
                                  <Badge key={action} variant="secondary">
                                    {t(`deployment.plan.action.${action}` as LocaleKey)}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <Alert>
                            <CheckCircle2Icon />
                            <AlertTitle>{t('deployment.plan.ready')}</AlertTitle>
                            <AlertDescription>{t('deployment.plan.readyDescription')}</AlertDescription>
                          </Alert>
                        )}
                      </CardContent>
                    </Card>
                  )}
                  {plan && (
                    <Card size="sm" variant="outline" radius="compact">
                      <CardHeader className="gap-x-4">
                        <CardTitle>{t('deployment.transfer.title')}</CardTitle>
                        <CardDescription>{t('deployment.transfer.description')}</CardDescription>
                        <CardAction>
                          {artifactTransferPhase !== 'idle' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void cancelArtifactTransfer().catch(() => undefined)}
                              disabled={artifactTransferPhase === 'cancelling'}
                            >
                              <SquareIcon data-icon="inline-start" />
                              {t('common.cancel')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => void transferArtifact().catch(() => undefined)}
                              disabled={actionBlocked || !planApproved || !artifactReady || Boolean(transferReady)}
                            >
                              <CloudUploadIcon data-icon="inline-start" />
                              {t('deployment.transfer.upload')}
                            </Button>
                          )}
                        </CardAction>
                      </CardHeader>
                      {(!planApproved || artifactTransferPhase !== 'idle' || artifactTransferResult?.failure || (transferReady && artifactTransferResult)) && (
                      <CardContent className="flex flex-col gap-3">
                        {!planApproved && (
                          <Alert variant="warning">
                            <Clock3Icon />
                            <AlertTitle>{t(planExpired || inputsChanged
                              ? 'deployment.transfer.refreshRequired'
                              : 'deployment.transfer.approvalRequired')}</AlertTitle>
                            <AlertDescription>{t(planExpired || inputsChanged
                              ? 'deployment.transfer.refreshRequiredDescription'
                              : 'deployment.transfer.approvalRequiredDescription')}</AlertDescription>
                          </Alert>
                        )}
                        {artifactTransferPhase !== 'idle' && (
                          <Alert role="status">
                            <Spinner role="presentation" aria-hidden />
                            <AlertTitle>{t(artifactTransferPhase === 'cancelling'
                              ? 'deployment.transfer.cancelling'
                              : 'deployment.transfer.running')}</AlertTitle>
                            <AlertDescription>
                              {artifactTransferProgress
                                ? t(`deployment.transfer.step.${artifactTransferProgress.step}` as LocaleKey)
                                : t('deployment.transfer.connecting')}
                              {artifactTransferProgress?.fileId ? ` · ${artifactTransferProgress.fileId}` : ''}
                              {artifactTransferProgress?.completedBytes != null
                                ? ` · ${formatBytes(artifactTransferProgress.completedBytes)}`
                                : ''}
                              {artifactTransferProgress?.totalBytes != null
                                ? ` / ${formatBytes(artifactTransferProgress.totalBytes)}`
                                : ''}
                            </AlertDescription>
                          </Alert>
                        )}
                        {artifactTransferResult?.failure && (
                          <Alert variant="destructive">
                            <AlertCircleIcon />
                            <AlertTitle>{t(`deployment.transfer.status.${artifactTransferResult.status}` as LocaleKey)}</AlertTitle>
                            <AlertDescription>
                              {t(`deployment.transfer.failure.${artifactTransferResult.failure.category}` as LocaleKey)}
                            </AlertDescription>
                          </Alert>
                        )}
                        {transferReady && artifactTransferResult && (
                          <>
                            <Alert>
                              <CheckCircle2Icon />
                              <AlertTitle>{t('deployment.transfer.verified')}</AlertTitle>
                              <AlertDescription>
                                {artifactTransferResult.reused
                                  ? t('deployment.transfer.reused')
                                  : artifactTransferResult.resumed
                                    ? t('deployment.transfer.resumed')
                                    : t('deployment.transfer.uploaded')}
                              </AlertDescription>
                            </Alert>
                            <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                              <div><span className="text-muted-foreground">{t('deployment.transfer.releaseId')}</span><div className="font-mono text-xs">{artifactTransferResult.releaseId}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.transfer.transferredBytes')}</span><div>{formatBytes(artifactTransferResult.transferredBytes)}</div></div>
                              <div><span className="text-muted-foreground">{t('deployment.transfer.remoteDigest')}</span><div className="break-all font-mono text-xs">{artifactTransferResult.remoteDigestSha256}</div></div>
                            </div>
                          </>
                        )}
                      </CardContent>
                      )}
                    </Card>
                  )}
                  {plan && (runnerReady || remoteRunnerPhase !== 'idle' || remoteRunnerResult) && (
                    <Card size="sm" variant="outline" radius="compact">
                      <CardHeader className="gap-x-4">
                        <CardTitle>{t('deployment.execute.title')}</CardTitle>
                        <CardDescription>{t('deployment.execute.description')}</CardDescription>
                        {(remoteRunnerPhase !== 'idle' || !remoteRunnerResult) && (
                          <CardAction>
                            {remoteRunnerPhase !== 'idle' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void cancelRemoteRunner().catch(() => undefined)}
                                disabled={remoteRunnerPhase === 'cancelling'}
                              >
                                <SquareIcon data-icon="inline-start" />
                                {t(stopRequiresRollback
                                  ? 'deployment.execute.stopAndRollback'
                                  : 'deployment.execute.stop')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => void runRemote().catch(() => undefined)}
                                disabled={actionBlocked || !runnerReady}
                              >
                                <ServerCogIcon data-icon="inline-start" />
                                {t('deployment.execute.run')}
                              </Button>
                            )}
                          </CardAction>
                        )}
                      </CardHeader>
                      {(remoteRunnerPhase !== 'idle' || remoteRunnerResult || remoteRunnerLog.length > 0) && (
                      <CardContent className="flex flex-col gap-3">
                        {remoteRunnerPhase !== 'idle' && (
                          <Alert role="status">
                            <Spinner role="presentation" aria-hidden />
                            <AlertTitle>{t(remoteRunnerPhase === 'cancelling'
                              ? 'deployment.execute.cancelling'
                              : 'deployment.execute.running')}</AlertTitle>
                            <AlertDescription>
                              {remoteRunnerProgress
                                ? t(`deployment.execute.step.${remoteRunnerProgress.step}` as LocaleKey)
                                : t('deployment.execute.connecting')}
                            </AlertDescription>
                          </Alert>
                        )}
                        {remoteRunnerResult && (
                          <Alert variant={remoteRunnerResult.status === 'succeeded'
                            ? 'default'
                            : remoteRunnerResult.status === 'rolledBack'
                              ? 'warning'
                              : 'destructive'}>
                            {remoteRunnerResult.status === 'succeeded'
                              ? <CheckCircle2Icon />
                              : remoteRunnerResult.status === 'rolledBack'
                                ? <ShieldAlertIcon />
                                : <AlertCircleIcon />}
                            <AlertTitle>{t(`deployment.execute.status.${remoteRunnerResult.status}` as LocaleKey)}</AlertTitle>
                            <AlertDescription>
                              {remoteRunnerResult.failureCategory
                                ? t(`deployment.execute.failure.${remoteRunnerResult.failureCategory}` as LocaleKey)
                                : t('deployment.execute.successDescription')}
                              {remoteRunnerResult.reconciliationRequired
                                ? ` ${t('deployment.execute.reconciliationRequired')}`
                                : ''}
                            </AlertDescription>
                          </Alert>
                        )}
                        {remoteRunnerLog.length > 0 && (
                          <div className="flex flex-col gap-2" aria-label={t('deployment.execute.log')}>
                            {remoteRunnerLog.map((entry) => (
                              <div key={entry.sequence} className="flex items-center gap-2 rounded-lg border p-2 text-xs">
                                <Badge variant="outline">{entry.sequence}</Badge>
                                <span className="font-medium">{t(`deployment.execute.step.${entry.step}` as LocaleKey)}</span>
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.summary}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                      )}
                    </Card>
                  )}
                  <Separator />
                  <p className="text-xs text-muted-foreground">{t('deployment.runtimeNotice')}</p>
                </div>
              </ScrollArea>
            )}
          </div>
        )}
      </WorkbenchPageContent>

      <Dialog
        open={historyOpen}
        onOpenChange={(open) => {
          setHistoryOpen(open);
          if (!open) void useDeploymentStore.getState().selectRun(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('deployment.history.title')}</DialogTitle>
            <DialogDescription>{t('deployment.history.description')}</DialogDescription>
          </DialogHeader>
          <DeploymentRunHistory
            display="dialog"
            onClose={() => {
              setHistoryOpen(false);
              void useDeploymentStore.getState().selectRun(null);
            }}
            onNavigateToWorkspace={() => setHistoryOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <WorkflowDialog
        open={dialogOpen}
        workflow={editing}
        defaultProfileId={profileFilterId ?? profiles[0]?.id ?? ''}
        saving={saving}
        onOpenChange={setDialogOpen}
      />
      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('deployment.approval.title')}</DialogTitle>
            <DialogDescription>{t('deployment.approval.description')}</DialogDescription>
          </DialogHeader>
          {plan && (
            <ScrollArea className="min-h-0 flex-1 pr-3">
              <div className="flex flex-col gap-4 text-sm">
                <Alert variant="warning">
                  <ShieldAlertIcon />
                  <AlertTitle>{t('deployment.approval.nativeOnly')}</AlertTitle>
                  <AlertDescription>{t('deployment.approval.nativeOnlyDescription')}</AlertDescription>
                </Alert>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><span className="text-muted-foreground">{t('deployment.plan.id')}</span><div className="break-all font-mono text-xs">{plan.planId}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.approval.digest')}</span><div className="break-all font-mono text-xs">{plan.planDigest}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.runId')}</span><div className="font-mono text-xs">{plan.runId} · r{plan.runRevision}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.expires')}</span><div>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(plan.expiresAt)}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.approval.workflow')}</span><div>{plan.approvalSummary.workflowId} · r{plan.approvalSummary.workflowRevision}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.approval.artifactReference')}</span><div className="break-all font-mono text-xs">{plan.approvalSummary.artifactReference}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.source')}</span><div className="break-all font-mono text-xs">{plan.approvalSummary.frozen.sourceRevision.revision}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.target')}</span><div>{plan.approvalSummary.frozen.target.username}@{plan.approvalSummary.frozen.target.host}:{plan.approvalSummary.frozen.target.port} · {plan.approvalSummary.frozen.target.authMethod}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.approval.profileRevision')}</span><div>{plan.approvalSummary.frozen.target.profileId} · {plan.approvalSummary.frozen.target.profileUpdatedAt}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.approval.jumpHost')}</span><div>{plan.approvalSummary.frozen.target.jumpHost ? `${plan.approvalSummary.frozen.target.jumpHost.username}@${plan.approvalSummary.frozen.target.jumpHost.host}:${plan.approvalSummary.frozen.target.jumpHost.port} · ${plan.approvalSummary.frozen.target.jumpHost.authMethod}` : t('deployment.summary.none')}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.remoteRoot')}</span><div className="break-all">{plan.approvalSummary.remoteRoot}</div></div>
                  <div><span className="text-muted-foreground">{t('deployment.plan.compose')}</span><div>{plan.approvalSummary.composeProject} · {plan.approvalSummary.composeFiles.join(', ')}</div></div>
                </div>
                {[['currentRelease', plan.approvalSummary.frozen.currentRelease], ['targetRelease', plan.approvalSummary.frozen.targetRelease], ['rollbackRelease', plan.approvalSummary.frozen.rollbackRelease]].map(([label, release]) => (
                  <div key={String(label)} className="rounded-lg border p-3">
                    <div className="text-muted-foreground">{t(`deployment.plan.${label}` as LocaleKey)}</div>
                    {typeof release === 'object' && release ? (
                      <div className="mt-1 grid gap-1 font-mono text-xs">
                        <span>{release.releaseId}</span>
                        <span className="break-all">{release.artifactDigestSha256}</span>
                      </div>
                    ) : t('deployment.summary.none')}
                  </div>
                ))}
                <div>
                  <div className="text-muted-foreground">{t('deployment.plan.actions')}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {plan.approvalSummary.actions.map((action) => (
                      <Badge key={action} variant="secondary">{t(`deployment.plan.action.${action}` as LocaleKey)}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-muted-foreground">{t('deployment.approval.preflight')}</div>
                  {plan.approvalSummary.frozen.preflight.checks.map((check) => (
                    <div key={check.code} className="flex items-start gap-2 rounded-lg border p-2">
                      <CheckIcon outcome={check.outcome} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{t(`deployment.preflight.check.${check.code}` as LocaleKey)}</div>
                        <div className="text-xs text-muted-foreground">{check.summary}</div>
                      </div>
                      <Badge variant={checkVariant(check)}>{t(`deployment.preflight.outcome.${check.outcome}`)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void rejectPlan().then(() => setApprovalOpen(false)).catch(() => undefined)}
              disabled={!plan || plan.status !== 'awaiting_approval' || approvalPhase !== 'idle'}
            >
              {t('deployment.approval.reject')}
            </Button>
            <Button
              onClick={() => void approvePlan().then(() => setApprovalOpen(false)).catch(() => undefined)}
              disabled={!admissionsEnabled || !plan || plan.status !== 'awaiting_approval' || approvalPhase !== 'idle' || planExpired || inputsChanged}
            >
              {approvalPhase === 'deciding' && <Spinner data-icon="inline-start" />}
              {t('deployment.approval.approve')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t('deployment.delete.title')}
        description={deleting ? t('deployment.delete.description', { name: deleting.name }) : ''}
        onConfirm={() => {
          if (!deleting) return;
          void deleteWorkflow(deleting.id, deleting.revision)
            .then(() => setDeleting(null))
            .catch(() => undefined);
        }}
      />
    </WorkbenchPage>
  );
};

export default DeploymentCenter;
