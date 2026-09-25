import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudUploadIcon,
  ListTreeIcon,
  PlusIcon,
  SaveIcon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Drawer, DrawerTitle } from '@/components/ui/drawer';
import { DeploymentDrawerContent, DeploymentDrawerHeader } from './deployment/deployment-drawer';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
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
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import { useDeploymentDraftCloseGuard } from '@/hooks/useDeploymentDraftCloseGuard';
import type {
  DeploymentEditorIssue,
  DeploymentWorkflowTemplateKind,
} from '@/lib/deployment/editor';
import type { LocaleKey } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import {
  useDeploymentWorkflowStore,
  type DeploymentWorkflowTab,
} from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useToastStore } from '@/stores/toastStore';
import {
  DeploymentWorkflowRuntimeOverlays,
  DeploymentWorkflowRuntimeView,
} from './deployment-workflow-runtime';
import {
  deploymentLocaleKey,
  readableDeploymentProfile,
} from './deployment/deployment-editor-ui';
import {
  DeploymentWorkspaceShell,
  type DeploymentWorkspaceLayout,
} from './deployment/deployment-workspace-shell';
import { DeploymentWorkflowTabs } from './deployment/deployment-workflow-tabs';
import { NodeInspector } from './deployment/node-inspector';
import { NodeLibraryDrawer } from './deployment/node-library-drawer';
import { WorkflowStepList } from './deployment/workflow-step-list';
import { WorkflowEditorToolbar } from './deployment/workflow-editor-toolbar';
import { WorkflowListPane } from './deployment/workflow-list-pane';
import { WorkflowSettingsDialog } from './deployment/workflow-settings-dialog';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader } from './workbench-page';

type Translate = (key: LocaleKey, values?: Record<string, string | number>) => string;

function localizedEditorError(error: string, t: Translate): string {
  if (error.includes('REVISION_CONFLICT')) return t('deployment.editor.error.revisionConflict');
  if (error.includes('DEPLOYMENT_WORKFLOW_DISABLED')) return t('deployment.editor.error.disabled');
  if (error.includes('PROFILE_NOT_FOUND')) return t('deployment.editor.error.profileMissing');
  return t('deployment.editor.error.generic');
}

interface TemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TemplateDialog: React.FC<TemplateDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const profileFilterId = useDeploymentWorkflowStore((state) => state.profileFilterId);
  const startTemplate = useDeploymentWorkflowStore((state) => state.startTemplate);
  const [kind, setKind] = React.useState<DeploymentWorkflowTemplateKind>('staticSite');
  const [name, setName] = React.useState('');
  const [profileId, setProfileId] = React.useState('');
  const [remoteRoot, setRemoteRoot] = React.useState('/srv/apps/example');
  const wasOpenRef = React.useRef(false);
  const templateOptions = React.useMemo(() => [
    { value: 'staticSite', label: t('deployment.editor.template.staticSite') },
    { value: 'dockerCompose', label: t('deployment.editor.template.dockerCompose') },
    { value: 'prebuiltFiles', label: t('deployment.editor.template.prebuiltFiles') },
    { value: 'blank', label: t('deployment.editor.template.blank') },
  ], [t]);
  const profileOptions = React.useMemo(() => profiles.map((profile) => ({
    value: profile.id,
    label: readableDeploymentProfile(profile),
  })), [profiles]);
  const normalizedRemoteRoot = remoteRoot.trim();
  const validRemoteRoot = normalizedRemoteRoot.startsWith('/') && normalizedRemoteRoot !== '/';

  React.useEffect(() => {
    if (!open) return;
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setKind('staticSite');
    setName('');
    const filteredProfile = profiles.find((profile) => profile.id === profileFilterId);
    setProfileId(filteredProfile?.id ?? profiles[0]?.id ?? '');
    setRemoteRoot('/srv/apps/example');
  }, [open, profileFilterId, profiles]);

  React.useEffect(() => {
    if (!open) wasOpenRef.current = false;
  }, [open]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || !profileId || !validRemoteRoot) return;
    startTemplate(kind, name.trim(), profileId, normalizedRemoteRoot);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>{t('deployment.editor.template.title')}</DialogTitle>
          <DialogDescription>{t('deployment.editor.template.description')}</DialogDescription>
        </DialogHeader>
        <form className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden" onSubmit={submit}>
          <ScrollArea className="min-h-0 min-w-0">
            <FieldGroup className="gap-3 p-4">
              <Field>
                <FieldLabel htmlFor="deployment-template">
                  {t('deployment.editor.template.kind')}
                </FieldLabel>
                <Select
                  items={templateOptions}
                  value={kind}
                  onValueChange={(value) => setKind(
                    (value ?? 'staticSite') as DeploymentWorkflowTemplateKind,
                  )}
                >
                  <SelectTrigger id="deployment-template" size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {templateOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {t(deploymentLocaleKey(`deployment.editor.template.${kind}Description`))}
                  {kind === 'prebuiltFiles' ? ` · ${t('deployment.editor.template.beta')}` : ''}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="deployment-name">
                  {t('deployment.editor.workflowName')}
                </FieldLabel>
                <Input
                  id="deployment-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-8"
                  autoFocus
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="deployment-profile">
                  {t('deployment.editor.targetProfile')}
                </FieldLabel>
                <Select
                  items={profileOptions}
                  value={profileId}
                  onValueChange={(value) => setProfileId(value ?? '')}
                >
                  <SelectTrigger id="deployment-profile" size="sm"><SelectValue /></SelectTrigger>
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
              <Field data-invalid={!validRemoteRoot && normalizedRemoteRoot !== '' ? 'true' : undefined}>
                <FieldLabel htmlFor="deployment-root">
                  {t('deployment.editor.remoteRoot')}
                </FieldLabel>
                <Input
                  id="deployment-root"
                  value={remoteRoot}
                  onChange={(event) => setRemoteRoot(event.target.value)}
                  className="h-8"
                  required
                  aria-invalid={!validRemoteRoot && normalizedRemoteRoot !== '' ? true : undefined}
                />
                {!validRemoteRoot && normalizedRemoteRoot !== '' && (
                  <FieldDescription className="text-destructive">
                    {t('deployment.editor.template.remoteRootInvalid')}
                  </FieldDescription>
                )}
              </Field>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 px-4 py-3">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || !profileId || !validRemoteRoot}
            >
              {t('deployment.editor.template.use')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface IssueListProps {
  issues: readonly DeploymentEditorIssue[];
  onSelectNode: (id: string) => void;
  nodeName: (id: string) => string;
}

const IssueList: React.FC<IssueListProps> = ({ issues, onSelectNode, nodeName }) => {
  const { t } = useI18n();
  if (issues.length === 0) {
    return (
      <Alert>
        <CheckCircle2Icon />
        <AlertTitle>{t('deployment.editor.validation.ready')}</AlertTitle>
        <AlertDescription>{t('deployment.editor.validation.readyDescription')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="deployment-validation-list">
      {issues.map((issue) => (
        <Alert key={issue.id} variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>{t(issue.messageKey)}</AlertTitle>
          <AlertDescription>
            {issue.nodeId
              ? t('deployment.editor.validation.nodeContext', { node: nodeName(issue.nodeId) })
              : t('deployment.editor.validation.workflowContext')}
          </AlertDescription>
          {issue.nodeId && (
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => onSelectNode(issue.nodeId!)}>
                {t('deployment.editor.validation.openNode')}
              </Button>
            </AlertAction>
          )}
        </Alert>
      ))}
    </div>
  );
};

export function DeploymentValidationDialog({
  open, onOpenChange, validating, onValidate, ...issueListProps
}: IssueListProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validating: boolean;
  onValidate: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(30rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>{t('deployment.editor.validation.title')}</DialogTitle>
          <DialogDescription>{t('deployment.editor.validation.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 min-w-0">
          <div className="p-4">
            <IssueList {...issueListProps} />
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button size="sm" onClick={onValidate} disabled={validating}>
            {validating && <Spinner data-icon="inline-start" />}
            {t('deployment.editor.validate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const UnsavedDraftNotice: React.FC = () => {
  const { t } = useI18n();
  return (
    <section
      // No border-r: the AI panel's resize handle owns the divider at this edge,
      // and a workspace border would stack into a 2px seam beside it.
      className="flex min-h-0 flex-1 flex-col items-center justify-center border-b"
      data-testid="deployment-unsaved-notice"
      aria-label={t('deployment.editor.placeholder.unsavedTitle')}
    >
      <div className="w-full max-w-lg p-3">
        <Alert>
          <SaveIcon />
          <AlertTitle>{t('deployment.editor.placeholder.unsavedTitle')}</AlertTitle>
          <AlertDescription>
            {t('deployment.editor.placeholder.unsavedDescription')}
          </AlertDescription>
        </Alert>
      </div>
    </section>
  );
};

export const DeploymentWorkflowCenter: React.FC<{
  initialTab?: DeploymentWorkflowTab;
}> = ({ initialTab }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const state = useDeploymentWorkflowStore();
  const runState = useDeploymentWorkflowRunStore();
  const addToast = useToastStore((toastState) => toastState.addToast);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [workflowsOpen, setWorkflowsOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [configOpen, setConfigOpen] = React.useState(false);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = React.useState<'create' | 'refresh' | null>(null);
  const [search, setSearch] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<DeploymentWorkflowTab>(
    () => initialTab ?? useDeploymentWorkflowStore.getState().activeTab,
  );
  const rememberActiveTab = state.setActiveTab;
  React.useEffect(() => {
    rememberActiveTab(activeTab);
  }, [activeTab, rememberActiveTab]);
  const closeGuard = useDeploymentDraftCloseGuard();
  const [approvalRequest, setApprovalRequest] = React.useState(0);
  const handledNoticeRef = React.useRef<number | null>(null);
  const handledErrorRef = React.useRef<string | null>(null);
  const handledRunNoticeRef = React.useRef<number | null>(null);
  const handledRunErrorRef = React.useRef<string | null>(null);
  const workflowsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const libraryTriggerRef = React.useRef<HTMLButtonElement>(null);
  const configTriggerRef = React.useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const deployTriggerRef = React.useRef<HTMLButtonElement>(null);
  const configFinalFocusRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!state.initialized && !state.loading) void state.initialize().catch(() => undefined);
  }, [state]);

  React.useEffect(() => {
    if (!state.requestedTab) return;
    setActiveTab(state.requestedTab);
    state.clearRequestedTab();
  }, [state]);

  React.useEffect(() => {
    if (!state.notice || handledNoticeRef.current === state.notice.id) return;
    handledNoticeRef.current = state.notice.id;
    addToast(t(deploymentLocaleKey(`deployment.editor.toast.${state.notice.kind}`)), 'success');
    if (state.notice.kind === 'saved' && state.draft?.id) {
      void runState.refreshWorkflow(state.draft.id).catch(() => undefined);
    }
    state.clearNotice();
  }, [addToast, runState, state, t]);

  React.useEffect(() => {
    const workflowId = state.draft?.id;
    if (!workflowId || runState.workflowId === workflowId) return;
    void runState.loadWorkflow(workflowId).catch(() => undefined);
  }, [runState, state.draft?.id]);

  React.useEffect(() => {
    if (!runState.notice || handledRunNoticeRef.current === runState.notice.id) return;
    handledRunNoticeRef.current = runState.notice.id;
    addToast(t(deploymentLocaleKey(`deployment.runtime.toast.${runState.notice.kind}`)), 'success');
    runState.clearNotice();
  }, [addToast, runState, t]);

  React.useEffect(() => {
    if (!runState.error) {
      handledRunErrorRef.current = null;
      return;
    }
    if (runState.errorContext === 'prepare' && activeTab === 'runs') return;
    if (handledRunErrorRef.current === runState.error) return;
    handledRunErrorRef.current = runState.error;
    addToast(t('deployment.runtime.error.generic'), 'error', 6_000);
    runState.clearError();
  }, [activeTab, addToast, runState, t]);

  React.useEffect(() => {
    if (!state.error) {
      handledErrorRef.current = null;
      return;
    }
    if (state.error.includes('VALIDATION_FAILED')) {
      // saveDraft already refreshed the issue list; surface it instead of
      // swallowing the rejection silently.
      if (state.draft && state.catalog) setIssuesOpen(true);
      state.clearError();
      return;
    }
    if (handledErrorRef.current === state.error) return;
    handledErrorRef.current = state.error;
    addToast(localizedEditorError(state.error, t), 'error', 6_000);
    state.clearError();
  }, [addToast, state, t]);

  const draft = state.draft;
  const catalog = state.catalog;
  const selectedRecord = draft?.id
    ? state.workflows.find((workflow) => workflow.id === draft.id) ?? null
    : null;
  const selectedNode = draft?.definition.nodes.find(
    (node) => node.id === state.selectedNodeId,
  ) ?? null;
  const admissionsEnabled = state.capabilities?.admissionsEnabled === true;
  const editable = admissionsEnabled && !state.saving;
  const dirty = state.semanticDirty || state.layoutDirty;
  const visibleWorkflows = state.profileFilterId
    ? state.workflows.filter((workflow) => workflow.definition.targets.some(
      (target) => target.connectionProfileId === state.profileFilterId,
    ))
    : state.workflows;

  React.useEffect(() => {
    if (draft?.id === null) {
      setActiveTab('pipeline');
      setSearch('');
    }
  }, [draft?.id]);

  React.useEffect(() => {
    if (!state.initialized || visibleWorkflows.length === 0) return;
    if (state.draft?.id === null) return;
    if (dirty) return;
    if (visibleWorkflows.some((workflow) => workflow.id === state.selectedWorkflowId)) return;
    state.selectWorkflow(visibleWorkflows[0]!.id);
  }, [dirty, state, visibleWorkflows]);

  const canDeploy = Boolean(selectedRecord)
    && admissionsEnabled
    && !state.semanticDirty
    && selectedRecord?.enabled === true;

  const deployHint = !admissionsEnabled
    ? t('deployment.editor.readOnly')
    : !selectedRecord
      ? t('deployment.runtime.deploy.unsavedWorkflow')
      : state.semanticDirty
        ? t('deployment.runtime.deploy.unsaved')
        : selectedRecord.enabled
          ? null
          : t('deployment.runtime.deploy.workflowDisabled');

  const startDeploy = React.useCallback((): void => {
    const record = selectedRecord;
    if (!record) return;
    setActiveTab('runs');
    void useDeploymentWorkflowRunStore.getState().prepare(record)
      .then(() => {
        const latest = useDeploymentWorkflowRunStore.getState();
        if (latest.workflowId === record.id) {
          setApprovalRequest((count) => count + 1);
        }
      })
      .catch(() => undefined);
  }, [selectedRecord]);

  React.useEffect(() => {
    if (!state.deployRequested) return;
    state.clearDeployRequest();
    if (!state.initialized || state.loading) return;
    if (canDeploy) {
      startDeploy();
    } else if (state.semanticDirty || state.layoutDirty) {
      addToast(t('deployment.center.deploy.unsavedChanges'), 'info');
    }
  }, [addToast, canDeploy, startDeploy, state, t]);

  const requestCreate = (): void => {
    if (dirty) {
      setPendingDiscardAction('create');
      return;
    }
    setTemplateOpen(true);
  };

  const requestRefresh = (): void => {
    if (dirty) {
      setPendingDiscardAction('refresh');
      return;
    }
    void state.refresh().catch(() => undefined);
  };

  const closeDiscardDialog = (): void => {
    setPendingDiscardAction(null);
    state.clearPendingSelection();
  };

  const confirmDiscard = (): void => {
    if (state.pendingSelectionId) {
      state.confirmPendingSelection();
      setWorkflowsOpen(false);
    } else if (pendingDiscardAction === 'refresh') {
      void state.refresh().catch(() => undefined);
    } else if (pendingDiscardAction === 'create') {
      setTemplateOpen(true);
    }
    setPendingDiscardAction(null);
  };

  const openConfiguration = (id: string, trigger: HTMLButtonElement): void => {
    state.selectNode(id);
    configFinalFocusRef.current = trigger;
    setConfigOpen(true);
  };

  const validate = async (): Promise<void> => {
    await state.validateDraft().catch(() => undefined);
    setIssuesOpen(true);
  };

  const workflowPane = (
    <WorkflowListPane
      workflows={visibleWorkflows}
      draftName={draft?.id === null ? draft.name : null}
      selectedWorkflowId={state.selectedWorkflowId}
      search={search}
      onSearchChange={setSearch}
      onSelect={state.selectWorkflow}
      onCreate={requestCreate}
      canCreate={editable}
      selectionDisabled={state.saving}
    />
  );
  const inspector = draft && catalog
    ? <NodeInspector draft={draft} node={selectedNode} catalog={catalog} editable={editable} />
    : null;

  return (
    <WorkbenchPage>
      <WorkbenchPageHeader
        icon={CloudUploadIcon}
        title={t('deployment.editor.title')}
        description={t('deployment.editor.description')}
      />
      <WorkbenchPageContent className="min-h-0 flex-1 gap-0 overflow-hidden p-0!">
        {state.capabilities && !admissionsEnabled && (
          <div className="shrink-0 border-b p-3">
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>{t('deployment.editor.readOnly')}</AlertTitle>
              <AlertDescription>
                {t('deployment.editor.readOnlyDescription', { flag: state.capabilities.flagName })}
              </AlertDescription>
            </Alert>
          </div>
        )}
        {!state.initialized && state.loading ? (
          <PanelLoadingState label={t('deployment.editor.loading')} />
        ) : profiles.length === 0 ? (
          <PanelEmptyState
            icon={<CloudUploadIcon />}
            title={t('deployment.noProfiles')}
            description={t('deployment.noProfilesDescription')}
          />
        ) : !draft || !catalog ? (
          <PanelEmptyState
            icon={<ListTreeIcon />}
            title={t('deployment.editor.empty')}
            description={t('deployment.editor.emptyDescription')}
            action={(
              <Button onClick={requestCreate} disabled={!editable}>
                <PlusIcon data-icon="inline-start" />
                {t('deployment.editor.newWorkflow')}
              </Button>
            )}
          />
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as DeploymentWorkflowTab)}
            className="min-h-0 flex-1 gap-0"
          >
            <DeploymentWorkflowTabs
              activeTab={activeTab}
              loading={state.loading}
              saving={state.saving}
              validating={state.validating}
              preparing={runState.preparing}
              canCreate={editable && profiles.length > 0}
              canSave={admissionsEnabled && dirty}
              canDeploy={canDeploy}
              deployHint={deployHint}
              onOpenWorkflows={() => setWorkflowsOpen(true)}
              onRefresh={requestRefresh}
              onCreate={requestCreate}
              onSave={() => void state.saveDraft().catch(() => undefined)}
              onValidate={() => void validate()}
              onDeploy={startDeploy}
              deployTriggerRef={deployTriggerRef}
              workflowsTriggerRef={workflowsTriggerRef}
            />
            <TabsContent value="pipeline" className="flex min-h-0 min-w-0 overflow-hidden">
              <DeploymentWorkspaceShell
                workflowPane={workflowPane}
                steps={(
                  <WorkflowStepList
                    draft={draft}
                    catalog={catalog}
                    issues={state.issues}
                    selectedNodeId={state.selectedNodeId}
                    editable={editable}
                    onSelectNode={state.selectNode}
                    onConfigure={openConfiguration}
                    onAddStep={(trigger) => {
                      libraryTriggerRef.current = trigger;
                      setLibraryOpen(true);
                    }}
                  />
                )}
                inspector={inspector}
                renderToolbar={(layout: DeploymentWorkspaceLayout) => (
                  <WorkflowEditorToolbar
                    workflowId={draft.id}
                    workflowName={draft.name}
                    layout={layout}
                    enabled={draft.enabled}
                    editable={editable}
                    issueCount={state.issues.length}
                    dirty={dirty}
                    onOpenIssues={() => setIssuesOpen(true)}
                    onOpenLibrary={() => setLibraryOpen(true)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenInspector={() => {
                      configFinalFocusRef.current = configTriggerRef.current;
                      setConfigOpen(true);
                    }}
                    libraryTriggerRef={libraryTriggerRef}
                    inspectorTriggerRef={configTriggerRef}
                    settingsTriggerRef={settingsTriggerRef}
                  />
                )}
              />
            </TabsContent>
            <TabsContent value="runs" className="flex min-h-0 min-w-0 overflow-hidden">
              {selectedRecord
                ? (
                  <DeploymentWorkflowRuntimeView
                    kind="runs"
                    workflow={selectedRecord}
                    catalog={catalog}
                    admissionsEnabled={admissionsEnabled}
                    onDeploy={startDeploy}
                    canDeploy={canDeploy}
                    approvalRequest={approvalRequest}
                    onApprovalHandled={() => setApprovalRequest(0)}
                    deployTriggerRef={deployTriggerRef}
                  />
                )
                : <UnsavedDraftNotice />}
            </TabsContent>
            <TabsContent value="versions" className="flex min-h-0 min-w-0 overflow-hidden">
              {selectedRecord
                ? (
                  <DeploymentWorkflowRuntimeView
                    kind="versions"
                    workflow={selectedRecord}
                    catalog={catalog}
                    admissionsEnabled={admissionsEnabled}
                  />
                )
                : <UnsavedDraftNotice />}
            </TabsContent>
          </Tabs>
        )}
      </WorkbenchPageContent>

      <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
      {draft && catalog && (
        <>
          <Drawer open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
            <DeploymentDrawerContent
              finalFocus={workflowsTriggerRef}
            >
              <DeploymentDrawerHeader>
                <DrawerTitle>{t('deployment.editor.workflows')}</DrawerTitle>
              </DeploymentDrawerHeader>
              <div className="min-h-0 flex-1">
                <WorkflowListPane
                  workflows={visibleWorkflows}
                  draftName={draft.id === null ? draft.name : null}
                  selectedWorkflowId={state.selectedWorkflowId}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={(id) => {
                    if (state.selectWorkflow(id)) {
                      setWorkflowsOpen(false);
                      return;
                    }
                    if (state.saving) addToast(t('deployment.editor.switchWhileSaving'), 'info');
                  }}
                  onCreate={() => {
                    setWorkflowsOpen(false);
                    requestCreate();
                  }}
                  canCreate={editable}
                  selectionDisabled={state.saving}
                  showHeader={false}
                />
              </div>
            </DeploymentDrawerContent>
          </Drawer>
          <NodeLibraryDrawer
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            catalog={catalog}
            editable={editable}
            finalFocusRef={libraryTriggerRef}
            onAdd={(spec) => {
              state.addNode(spec.typeName, spec.typeVersion);
              setLibraryOpen(false);
            }}
          />
          <WorkflowSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            draft={draft}
            editable={editable}
            returnFocusRef={settingsTriggerRef}
          />
          <Drawer open={configOpen} onOpenChange={setConfigOpen}>
            <DeploymentDrawerContent
              finalFocus={configFinalFocusRef}
            >
              <div className="min-h-0 flex-1">{inspector}</div>
            </DeploymentDrawerContent>
          </Drawer>
          <DeploymentValidationDialog
            open={issuesOpen}
            onOpenChange={setIssuesOpen}
            validating={state.validating}
            onValidate={() => void validate()}
            issues={state.issues}
            nodeName={(id) => draft.definition.nodes.find(
              (item) => item.id === id,
            )?.displayName ?? t('deployment.editor.validation.workflowContext')}
            onSelectNode={(id) => {
              state.selectNode(id);
              setIssuesOpen(false);
            }}
          />
        </>
      )}
      <AlertDialog
        open={state.pendingSelectionId !== null || pendingDiscardAction !== null}
        onOpenChange={(open) => { if (!open) closeDiscardDialog(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deployment.editor.discard.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deployment.editor.discard.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDiscard}>
              {t('deployment.editor.discard.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={closeGuard.confirmOpen}
        onOpenChange={(open) => { if (!open) closeGuard.cancelClose(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deployment.editor.closeGuard.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deployment.editor.closeGuard.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={closeGuard.confirmClose}>
              {t('deployment.editor.closeGuard.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DeploymentWorkflowRuntimeOverlays />
    </WorkbenchPage>
  );
};
