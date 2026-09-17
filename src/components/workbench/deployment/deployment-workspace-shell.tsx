import React from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';

export type DeploymentWorkspaceLayout = 'narrow' | 'medium' | 'wide';

interface DeploymentWorkspaceShellProps {
  workflowPane: React.ReactNode;
  canvas: React.ReactNode;
  inspector: React.ReactNode;
  topology: React.ReactNode;
  statusBar: React.ReactNode;
  renderToolbar: (layout: DeploymentWorkspaceLayout) => React.ReactNode;
}

function layoutForWidth(width: number): DeploymentWorkspaceLayout {
  if (width >= 1_152) return 'wide';
  if (width >= 768) return 'medium';
  return 'narrow';
}

export const DeploymentWorkspaceShell: React.FC<DeploymentWorkspaceShellProps> = ({
  workflowPane,
  canvas,
  inspector,
  topology,
  statusBar,
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

  const editor = layout && layout !== 'narrow' ? (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-background">
      {renderToolbar(layout)}
      <div className="min-h-0 min-w-0 flex-1">{canvas}</div>
      {statusBar}
    </section>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="@container flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="deployment-design-workspace"
      data-layout={layout ?? 'measuring'}
    >
      {layout === 'wide' && (
        <div className="flex min-h-0 min-w-0 flex-1" data-testid="deployment-workspace-wide">
          <ResizablePanelGroup
            id="deployment-workspace-panels"
            orientation="horizontal"
            defaultLayout={{ workflows: 18, canvas: 58, inspector: 24 }}
            className="min-h-0 min-w-0"
          >
            <ResizablePanel id="workflows" defaultSize="18%" minSize="14%" maxSize="24%">
              {workflowPane}
            </ResizablePanel>
            <ResizableHandle aria-label={t('deployment.editor.resize.workflows')} />
            <ResizablePanel id="canvas" defaultSize="58%" minSize="42%">
              {editor}
            </ResizablePanel>
            <ResizableHandle aria-label={t('deployment.editor.resize.inspector')} />
            <ResizablePanel id="inspector" defaultSize="24%" minSize="20%" maxSize="30%">
              {inspector}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
      {layout === 'medium' && (
        <div className="flex min-h-0 min-w-0 flex-1 @min-[72rem]:hidden" data-testid="deployment-workspace-medium">
          {editor}
        </div>
      )}
      {layout === 'narrow' && (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col @min-[48rem]:hidden" data-testid="deployment-workspace-narrow">
          {renderToolbar(layout)}
          <ScrollArea className="min-h-0 flex-1">{topology}</ScrollArea>
          {statusBar}
        </section>
      )}
    </div>
  );
};
