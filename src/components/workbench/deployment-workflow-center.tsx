import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudUploadIcon,
  ListTreeIcon,
  PlusIcon,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
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
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useI18n } from '@/hooks/useI18n';
import type {
  DeploymentEditorIssue,
  DeploymentWorkflowTemplateKind,
} from '@/lib/deployment/editor';
import type { LocaleKey } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
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
import {
  DeploymentWorkflowTabs,
  type DeploymentWorkflowTab,
} from './deployment/deployment-workflow-tabs';
import { NodeInspector } from './deployment/node-inspector';
import { NodeLibraryDrawer } from './deployment/node-library-drawer';
import { ValidationStatusBar } from './deployment/validation-status-bar';
import { WorkflowCanvas } from './deployment/workflow-canvas';
import { WorkflowEditorToolbar } from './deployment/workflow-editor-toolbar';
import { WorkflowListPane } from './deployment/workflow-list-pane';
import { WorkflowTopologyList } from './deployment/workflow-topology-list';
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
  const startTemplate = useDeploymentWorkflowStore((state) => state.startTemplate);
  const [kind, setKind] = React.useState<DeploymentWorkflowTemplateKind>('staticSite');
  const [name, setName] = React.useState('');
  const [profileId, setProfileId] = React.useState('');
  const [remoteRoot, setRemoteRoot] = React.useState('/srv/apps/example');
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
    setKind('staticSite');
    setName('');
    setProfileId(profiles[0]?.id ?? '');
    setRemoteRoot('/srv/apps/example');
  }, [open, profiles]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || !profileId || !validRemoteRoot) return;
    startTemplate(kind, name.trim(), profileId, normalizedRemoteRoot);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(40rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 p-4">
          <DialogTitle>{t('deployment.editor.template.title')}</DialogTitle>
          <DialogDescription>{t('deployment.editor.template.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submit}>
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="px-4 pb-4">
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
                  <SelectTrigger id="deployment-template"><SelectValue /></SelectTrigger>
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
                  <SelectTrigger id="deployment-profile"><SelectValue /></SelectTrigger>
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
              <Field>
                <FieldLabel htmlFor="deployment-root">
                  {t('deployment.editor.remoteRoot')}
                </FieldLabel>
                <Input
                  id="deployment-root"
                  value={remoteRoot}
                  onChange={(event) => setRemoteRoot(event.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 border-t p-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !profileId || !validRemoteRoot}
            >
              <PlusIcon data-icon="inline-start" />
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

const PlaceholderView: React.FC<{ kind: Exclude<DeploymentWorkflowTab, 'design'> }> = ({ kind }) => {
  const { t } = useI18n();
  return (
    <section className="flex min-h-0 flex-1 flex-col border" aria-label={t(deploymentLocaleKey(`deployment.editor.tab.${kind}`))}>
      <header className="flex items-start justify-between gap-2 border-b p-3">
        <div>
          <h2 className="text-sm font-medium">
            {t(deploymentLocaleKey(`deployment.editor.tab.${kind}`))}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(deploymentLocaleKey(`deployment.editor.placeholder.${kind}`))}
          </p>
        </div>
        <Badge variant="secondary">{t('deployment.editor.placeholder.empty')}</Badge>
      </header>
    </section>
  );
};

export const DeploymentWorkflowCenter: React.FC<{
  initialTab?: DeploymentWorkflowTab;
}> = ({ initialTab = 'design' }) => {
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
  const [activeTab, setActiveTab] = React.useState<DeploymentWorkflowTab>(initialTab);
  const handledNoticeRef = React.useRef<number | null>(null);
  const handledErrorRef = React.useRef<string | null>(null);
  const handledRunNoticeRef = React.useRef<number | null>(null);
  const handledRunErrorRef = React.useRef<string | null>(null);
  const workflowsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const libraryTriggerRef = React.useRef<HTMLButtonElement>(null);
  const configTriggerRef = React.useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = React.useRef<HTMLButtonElement>(null);
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
    if (runState.errorContext === 'prepare' && activeTab === 'prepare') return;
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
    if (!state.initialized || visibleWorkflows.length === 0) return;
    if (state.draft?.id === null) return;
    if (dirty) return;
    if (visibleWorkflows.some((workflow) => workflow.id === state.selectedWorkflowId)) return;
    state.selectWorkflow(visibleWorkflows[0]!.id);
  }, [dirty, state, visibleWorkflows]);

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
    const issues = await state.validateDraft().catch(() => []);
    setIssuesOpen(issues.length > 0);
  };

  const workflowPane = (
    <WorkflowListPane
      workflows={visibleWorkflows}
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
        titleMeta={draft?.id
          ? <Badge variant="outline">{t('deployment.editor.revision', { revision: draft.revision })}</Badge>
          : undefined}
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
          <EmptyState
            icon={<CloudUploadIcon />}
            title={t('deployment.noProfiles')}
            description={t('deployment.noProfilesDescription')}
          />
        ) : !draft || !catalog ? (
          <EmptyState
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
              canCreate={editable && profiles.length > 0}
              canSave={admissionsEnabled && dirty}
              onOpenWorkflows={() => setWorkflowsOpen(true)}
              onRefresh={requestRefresh}
              onCreate={requestCreate}
              onSave={() => void state.saveDraft().catch(() => undefined)}
              onValidate={() => void validate()}
              workflowsTriggerRef={workflowsTriggerRef}
            />
            <TabsContent value="design" className="flex min-h-0 min-w-0 overflow-hidden">
              <DeploymentWorkspaceShell
                workflowPane={workflowPane}
                canvas={(
                  <WorkflowCanvas
                    draft={draft}
                    catalog={catalog}
                    selectedNodeId={state.selectedNodeId}
                    issues={state.issues}
                    editable={editable}
                  />
                )}
                inspector={inspector}
                topology={(
                  <WorkflowTopologyList
                    draft={draft}
                    catalog={catalog}
                    issues={state.issues}
                    editable={editable}
                    onConfigure={openConfiguration}
                  />
                )}
                statusBar={(
                  <ValidationStatusBar
                    issueCount={state.issues.length}
                    semanticDirty={state.semanticDirty}
                    layoutDirty={state.layoutDirty}
                    selectedNodeName={selectedNode?.displayName ?? null}
                    onOpenIssues={() => setIssuesOpen(true)}
                  />
                )}
                renderToolbar={(layout: DeploymentWorkspaceLayout) => (
                  <WorkflowEditorToolbar
                    workflowName={draft.name}
                    layout={layout}
                    enabled={draft.enabled}
                    editable={editable}
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
            <TabsContent value="prepare" className="flex min-h-0 min-w-0 overflow-hidden">
              {selectedRecord
                ? (
                  <DeploymentWorkflowRuntimeView
                    kind="prepare"
                    workflow={selectedRecord}
                    catalog={catalog}
                    semanticDirty={state.semanticDirty}
                    admissionsEnabled={admissionsEnabled}
                  />
                )
                : <PlaceholderView kind="prepare" />}
            </TabsContent>
            <TabsContent value="runs" className="flex min-h-0 min-w-0 overflow-hidden">
              {selectedRecord
                ? (
                  <DeploymentWorkflowRuntimeView
                    kind="runs"
                    workflow={selectedRecord}
                    catalog={catalog}
                    admissionsEnabled={admissionsEnabled}
                  />
                )
                : <PlaceholderView kind="runs" />}
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
                : <PlaceholderView kind="versions" />}
            </TabsContent>
          </Tabs>
        )}
      </WorkbenchPageContent>

      <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
      {draft && catalog && (
        <>
          <Drawer open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
            <DrawerContent
              className="min-h-0 gap-0 overflow-hidden p-0"
              finalFocus={workflowsTriggerRef}
            >
              <DrawerHeader className="shrink-0 border-b p-4">
                <DrawerTitle>{t('deployment.editor.workflows')}</DrawerTitle>
              </DrawerHeader>
              <div className="min-h-0 flex-1">
                <WorkflowListPane
                  workflows={visibleWorkflows}
                  selectedWorkflowId={state.selectedWorkflowId}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={(id) => {
                    if (state.selectWorkflow(id)) setWorkflowsOpen(false);
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
            </DrawerContent>
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
            <DrawerContent
              className="min-h-0 gap-0 overflow-hidden p-0"
              finalFocus={configFinalFocusRef}
            >
              <DrawerHeader className="shrink-0 border-b p-4">
                <DrawerTitle>{t('deployment.editor.configuration')}</DrawerTitle>
              </DrawerHeader>
              <div className="min-h-0 flex-1">{inspector}</div>
            </DrawerContent>
          </Drawer>
          <Dialog open={issuesOpen} onOpenChange={setIssuesOpen}>
            <DialogContent className="flex h-[min(36rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
              <DialogHeader className="shrink-0 p-4">
                <DialogTitle>{t('deployment.editor.validation.title')}</DialogTitle>
                <DialogDescription>{t('deployment.editor.validation.description')}</DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-4 pb-4">
                  <IssueList
                    issues={state.issues}
                    nodeName={(id) => draft.definition.nodes.find(
                      (item) => item.id === id,
                    )?.displayName ?? t('deployment.editor.validation.workflowContext')}
                    onSelectNode={(id) => {
                      state.selectNode(id);
                      setIssuesOpen(false);
                    }}
                  />
                </div>
              </ScrollArea>
              <DialogFooter className="shrink-0 border-t p-4">
                <Button variant="outline" onClick={() => setIssuesOpen(false)}>
                  {t('common.close')}
                </Button>
                <Button onClick={() => void validate()} disabled={state.validating}>
                  {state.validating && <Spinner data-icon="inline-start" />}
                  {t('deployment.editor.validate')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
      <DeploymentWorkflowRuntimeOverlays />
    </WorkbenchPage>
  );
};
