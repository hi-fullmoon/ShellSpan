// Read-only rendering of recorded acceptance evidence. No IPC implementation,
// credential, network response, or persisted business record is replaced here.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/base.css';
import release from '../../docs/design/deployment-center-product-phase-3-evidence.json';
import lifecycle from '../../docs/design/deployment-center-product-phase-4-lifecycle-evidence.json';
import onboarding from '../../docs/design/deployment-center-product-phase-2-evidence.json';
import native from '../../docs/design/deployment-center-product-phase-5-native-render-data.json';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import type { DeploymentRunDetail, DeploymentRunNodeRecord, DeploymentWorkflowRecord, DeploymentReleaseRecord } from '@/lib/deployment/types';
import type { DeploymentReadinessReport, DeploymentEnvironmentConfig, DeploymentApplicationEntry } from '@/lib/deployment/applications';
import { HostComposeFields } from '@/components/workbench/deployment/host-compose-fields';
import { DeploymentWorkflowRuntimeView, RunStatusAlert, PreparationProgress } from '@/components/workbench/deployment-workflow-runtime';
import { ApprovalDialog } from '@/components/workbench/deployment/approval-dialog';
import { ArtifactDrawer } from '@/components/workbench/deployment/artifact-drawer';
import { ApplicationOnboarding, ReadinessItems } from '@/components/workbench/deployment/application-center';
import { WorkflowSettingsDialog } from '@/components/workbench/deployment/workflow-settings-dialog';
import { WorkflowListPane } from '@/components/workbench/deployment/workflow-list-pane';
import { WorkbenchPage } from '@/components/workbench/workbench-page';
import { DeploymentValidationDialog } from '@/components/workbench/deployment-workflow-center';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { Button } from '@/components/ui/button';

const query = new URLSearchParams(location.search);
const locale = query.get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
const mode = query.get('mode') ?? 'runtime';
const width = Number(query.get('width') ?? 1418);
const workflow = (mode === 'versions' ? native.workflow : release.workflow) as unknown as DeploymentWorkflowRecord;
const runtime = mode === 'runtime' || mode === 'runtime-rollback' || mode === 'runtime-loading';
const detail = (mode === 'rollback' || mode === 'runtime-rollback' ? lifecycle.rollback : release.detail) as unknown as DeploymentRunDetail;
useAppStore.setState({ locale });
await initI18n(locale);
document.documentElement.lang = locale;
document.documentElement.dataset.theme = 'light';
useDeploymentWorkflowRunStore.setState({
  workflowId: workflow.id,
  detail: mode !== 'runtime-loading' && (runtime || ['approval', 'rollback'].includes(mode)) ? detail : null,
  runs: runtime ? [detail.summary] : [],
  selectedRunId: runtime ? detail.summary.runId : null,
  nodes: mode === 'runtime-rollback' ? lifecycle.rollbackNodes as DeploymentRunNodeRecord[] : [],
  loading: mode === 'loading' || mode === 'runtime-loading',
  releases: mode === 'versions' ? native.releases as DeploymentReleaseRecord[] : [],
});

function View(): React.JSX.Element {
  const validating = useDeploymentWorkflowStore((state) => state.validating);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [config, setConfig] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [hostConfig, setHostConfig] = React.useState<DeploymentEnvironmentConfig>(onboarding.entry.environment.config as DeploymentEnvironmentConfig);
  return <div style={{ width, maxWidth: '100vw', height: '100dvh' }} data-testid="acceptance-container">
    <WorkbenchPage>
      {mode === 'validation' && <DeploymentValidationDialog open onOpenChange={() => undefined}
        validating={validating} onValidate={() => useDeploymentWorkflowStore.setState({ validating: true })}
        issues={[]} nodeName={(id) => id} onSelectNode={() => undefined} />}
      {mode === 'host-compose' && <div className="min-h-0 flex-1 overflow-auto p-4"><HostComposeFields config={hostConfig} onChange={(patch) => setHostConfig({ ...hostConfig, ...patch })} /></div>}
      {['runtime', 'runtime-rollback', 'runtime-loading', 'empty', 'loading', 'versions', 'versions-empty'].includes(mode) && <DeploymentWorkflowRuntimeView
        workflow={workflow} kind={mode.startsWith('versions') ? 'versions' : 'runs'} admissionsEnabled={false}
        onOpenDeploymentChecks={(trigger) => { triggerRef.current = trigger; setConfig(true); }} />}
      {mode === 'list' && <WorkflowListPane workflows={[workflow]} selectedWorkflowId={workflow.id}
        search={search} onSearchChange={setSearch} onSelect={() => undefined} onCreate={() => undefined} canCreate={false} />}
      {mode === 'recovery' && <RunStatusAlert status={lifecycle.failed.summary.status as 'failed'}
        detail={lifecycle.failed as unknown as DeploymentRunDetail} onReconcile={() => undefined}
        hasEvidence onOpenEvidence={() => undefined} />}
      {/* State-only presentation contracts; these do not invent a run or remote evidence. */}
      {mode === 'artifact-loading' && <>
        <Button onClick={() => useDeploymentWorkflowRunStore.setState({ action: 'artifact' })}>
          {t('deployment.runtime.artifact.open')}
        </Button>
        <ArtifactDrawer />
      </>}
      {mode === 'unknown' && <RunStatusAlert status="state_unknown" onReconcile={() => undefined} />}
      {mode === 'preparing' && <PreparationProgress />}
      {mode === 'readiness' && <div className="overflow-auto p-3"><ReadinessItems report={onboarding.report as DeploymentReadinessReport} /></div>}
      {['approval', 'rollback', 'settings'].includes(mode) && <Button ref={triggerRef} onClick={() => setOpen(true)}>
        {t(mode === 'settings' ? 'deployment.editor.settings' : 'deployment.runtime.reviewApproval')}
      </Button>}
      {['approval', 'rollback'].includes(mode) && <ApprovalDialog open={open} onOpenChange={setOpen}
        workflow={workflow} admissionsEnabled={false} returnFocusRef={triggerRef} />}
      {mode === 'settings' && <WorkflowSettingsDialog open={open} onOpenChange={setOpen}
        draft={{ ...workflow, layout: workflow.layout ?? { schemaVersion: 1, nodes: {}, groups: [] } }} editable
        returnFocusRef={triggerRef} onConfigureDeployment={() => setConfig(true)} />}
      {config && <ApplicationOnboarding initial={query.has('configured') ? onboarding.entry as DeploymentApplicationEntry : null} workflowId={null} triggerRef={triggerRef}
        onSaved={() => undefined} onClose={() => setConfig(false)} />}
    </WorkbenchPage>
  </div>;
}
createRoot(document.getElementById('root')!).render(<View />);
