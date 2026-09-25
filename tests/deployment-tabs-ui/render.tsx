import React from 'react';
import { createRoot } from 'react-dom/client';
import { CloudUploadIcon } from 'lucide-react';
import '@/styles/base.css';
import evidence from '../../docs/design/deployment-center-product-phase-5-native-render-data.json';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { WorkbenchPage, WorkbenchPageHeader } from '@/components/workbench/workbench-page';
import { DeploymentWorkflowTabs } from '@/components/workbench/deployment/deployment-workflow-tabs';
import type { DeploymentWorkflowTab } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';

// Presentation-only exercise of the production toolbar with a recorded workflow
// name. No backend calls or deployment results are substituted.
const locale = new URLSearchParams(location.search).get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);

function View(): React.JSX.Element {
  const preparing = useDeploymentWorkflowRunStore((state) => state.preparing);
  const [tab, setTab] = React.useState<DeploymentWorkflowTab>('pipeline');
  return <div style={{ height: '100dvh' }}><WorkbenchPage>
    <WorkbenchPageHeader icon={CloudUploadIcon} title={t('deployment.editor.title')}
      description={t('deployment.editor.currentWorkflow', { name: evidence.workflow.name })} />
    <Tabs value={tab} onValueChange={(value) => setTab(value as DeploymentWorkflowTab)} className="min-h-0 flex-1 gap-0">
      <DeploymentWorkflowTabs activeTab={tab} loading={false} saving={false} validating={false} preparing={preparing}
        canCreate canSave canDeploy deployHint={null}
        onOpenWorkflows={() => undefined} onRefresh={() => undefined} onCreate={() => undefined}
        onSave={() => undefined} onValidate={() => undefined} onDeploy={() => undefined} />
      {(['pipeline', 'runs', 'versions'] as const).map((value) => <TabsContent key={value} value={value} keepMounted
        className="flex min-h-0 min-w-0 overflow-hidden data-[hidden]:hidden">
        {t(`deployment.editor.tab.${value}`)}
      </TabsContent>)}
    </Tabs>
  </WorkbenchPage></div>;
}
createRoot(document.getElementById('root')!).render(<View />);
