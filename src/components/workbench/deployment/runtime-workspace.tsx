import React from 'react';
import { HistoryIcon, PanelRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useI18n } from '@/hooks/useI18n';
import { DeploymentPaneHeader } from './deployment-pane-header';

type RuntimeWorkspaceLayout = 'narrow' | 'medium' | 'wide';

function layoutForWidth(width: number): RuntimeWorkspaceLayout {
  if (width >= 1_152) return 'wide';
  if (width >= 768) return 'medium';
  return 'narrow';
}

export interface RuntimeWorkspaceProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
  runPane: React.ReactNode;
  flow: React.ReactNode;
  inspector: React.ReactNode;
}

export const RuntimeWorkspace: React.FC<RuntimeWorkspaceProps> = ({
  title,
  description,
  actions,
  runPane,
  flow,
  inspector,
}) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const runsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const inspectorTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = React.useState<RuntimeWorkspaceLayout | null>(null);
  const [runsOpen, setRunsOpen] = React.useState(false);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);

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

  const main = (
    <section className="flex size-full min-h-0 min-w-0 flex-col bg-background">
      <DeploymentPaneHeader
        title={title}
        description={description}
        actions={(
          <>
            {actions}
            {layout !== 'wide' && (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  ref={runsTriggerRef}
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setRunsOpen(true)}
                  aria-label={t('deployment.runtime.runs.title')}
                >
                  <HistoryIcon data-icon="inline-start" />
                </Button>
                <Button
                  ref={inspectorTriggerRef}
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setInspectorOpen(true)}
                  aria-label={t('deployment.runtime.node.details')}
                  data-testid="deployment-open-runtime-inspector"
                >
                  <PanelRightIcon data-icon="inline-start" />
                </Button>
              </div>
            )}
          </>
        )}
      />
      <div className="min-h-0 min-w-0 flex-1">{flow}</div>
    </section>
  );

  return (
    <div
      ref={rootRef}
      // No border-r: the AI panel's resize handle owns the divider at this edge,
      // and a workspace border would stack into a 2px seam beside it.
      className="@container flex min-h-0 min-w-0 flex-1 overflow-hidden border-b"
      data-testid="deployment-runtime-workspace"
      data-layout={layout ?? 'measuring'}
    >
      {layout === 'wide' ? (
        <ResizablePanelGroup
          id="deployment-runtime-panels"
          orientation="horizontal"
          defaultLayout={{ runs: 18, flow: 58, inspector: 24 }}
          className="min-h-0 min-w-0"
        >
          <ResizablePanel id="runs" defaultSize="18%" minSize="14%" maxSize="24%">
            {runPane}
          </ResizablePanel>
          <ResizableHandle aria-label={t('deployment.runtime.resize.runs')} />
          <ResizablePanel id="flow" defaultSize="58%" minSize="42%">
            {main}
          </ResizablePanel>
          <ResizableHandle aria-label={t('deployment.runtime.resize.inspector')} />
          <ResizablePanel id="inspector" defaultSize="24%" minSize="20%" maxSize="30%">
            {inspector}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : layout ? main : null}

      <Drawer open={runsOpen} onOpenChange={setRunsOpen}>
        <DrawerContent
          className="min-h-0 gap-0 overflow-hidden p-0"
          finalFocus={runsTriggerRef}
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t('deployment.runtime.runs.title')}</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 flex-1">{runPane}</div>
        </DrawerContent>
      </Drawer>
      <Drawer open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <DrawerContent
          className="min-h-0 gap-0 overflow-hidden p-0"
          finalFocus={inspectorTriggerRef}
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t('deployment.runtime.node.details')}</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 flex-1">{inspector}</div>
        </DrawerContent>
      </Drawer>
    </div>
  );
};
