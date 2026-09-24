import React from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useI18n } from '@/hooks/useI18n';

export type DeploymentWorkspaceLayout = 'compact' | 'wide';

interface DeploymentWorkspaceShellProps {
  workflowPane: React.ReactNode;
  steps: React.ReactNode;
  inspector: React.ReactNode;
  renderToolbar: (layout: DeploymentWorkspaceLayout) => React.ReactNode;
}

function layoutForWidth(width: number): DeploymentWorkspaceLayout {
  return width >= 1_152 ? 'wide' : 'compact';
}

export const DeploymentWorkspaceShell: React.FC<DeploymentWorkspaceShellProps> = ({
  workflowPane,
  steps,
  inspector,
  renderToolbar,
}) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = React.useState<DeploymentWorkspaceLayout | null>(null);

  React.useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;

    const update = (width: number): void => {
      setLayout(layoutForWidth(width > 0 ? width : 1_152));
    };
    const measure = (): void => update(element.getBoundingClientRect().width);

    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(([entry]) => {
        if (entry) update(entry.contentRect.width);
      });
    observer?.observe(element);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  const editor = (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-background">
      {renderToolbar(layout ?? 'wide')}
      <div className="min-h-0 min-w-0 flex-1">{steps}</div>
    </section>
  );

  return (
    <div
      ref={rootRef}
      // No border-r: the AI panel's resize handle owns the divider at this edge,
      // and a workspace border would stack into a 2px seam beside it.
      className="@container flex min-h-0 min-w-0 flex-1 overflow-hidden border-b"
      data-testid="deployment-design-workspace"
      data-layout={layout ?? 'measuring'}
    >
      {layout === 'wide' && (
        <div className="flex min-h-0 min-w-0 flex-1" data-testid="deployment-workspace-wide">
          <ResizablePanelGroup
            id="deployment-workspace-panels"
            orientation="horizontal"
            defaultLayout={{ workflows: 18, steps: 58, inspector: 24 }}
            className="min-h-0 min-w-0"
          >
            <ResizablePanel id="workflows" defaultSize="18%" minSize="14%" maxSize="24%">
              {workflowPane}
            </ResizablePanel>
            <ResizableHandle aria-label={t('deployment.editor.resize.workflows')} />
            <ResizablePanel id="steps" defaultSize="58%" minSize="42%">
              {editor}
            </ResizablePanel>
            <ResizableHandle aria-label={t('deployment.editor.resize.inspector')} />
            <ResizablePanel id="inspector" defaultSize="24%" minSize="20%" maxSize="30%">
              {inspector}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
      {layout === 'compact' && (
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="deployment-workspace-compact"
        >
          {editor}
        </section>
      )}
    </div>
  );
};
