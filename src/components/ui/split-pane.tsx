import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

export interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  minWidth?: number;
  direction?: 'horizontal' | 'vertical';
  defaultSplit?: number;
  split?: number;
  onSplitChange?: (split: number) => void;
  className?: string;
  dividerStyle?: 'default' | 'subtle';
  id?: string;
}

const clampSplit = (split: number): number => Math.min(0.99, Math.max(0.01, split));

export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  minWidth = 240,
  direction = 'horizontal',
  defaultSplit = 0.5,
  split: controlledSplit,
  onSplitChange,
  className,
  dividerStyle = 'default',
  id,
}) => {
  const reactId = React.useId().replace(/:/g, '');
  const groupId = id ?? `split-pane-${reactId}`;
  const firstPanelId = `${groupId}-first`;
  const secondPanelId = `${groupId}-second`;
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [internalSplit, setInternalSplit] = useState(() => clampSplit(defaultSplit));
  const effectiveSplit = clampSplit(controlledSplit ?? internalSplit);
  const effectiveSplitRef = useRef(effectiveSplit);
  effectiveSplitRef.current = effectiveSplit;

  const defaultLayout = useMemo<Layout>(() => ({
    [firstPanelId]: effectiveSplit * 100,
    [secondPanelId]: (1 - effectiveSplit) * 100,
  }), [effectiveSplit, firstPanelId, secondPanelId]);

  const handleLayoutChanged = useCallback((layout: Layout, meta: { isUserInteraction: boolean }) => {
    if (!meta.isUserInteraction) return;
    const firstSize = layout[firstPanelId];
    if (typeof firstSize !== 'number') return;
    const next = clampSplit(firstSize / 100);
    if (controlledSplit === undefined) setInternalSplit(next);
    onSplitChange?.(next);
  }, [controlledSplit, firstPanelId, onSplitChange]);

  // The resizable primitive owns live drag state. This effect only synchronizes
  // a genuinely controlled value changed by the parent.
  useEffect(() => {
    if (controlledSplit === undefined) return;
    const currentLayout = groupRef.current?.getLayout();
    const currentFirstSize = currentLayout?.[firstPanelId];
    const targetFirstSize = effectiveSplitRef.current * 100;
    if (typeof currentFirstSize === 'number' && Math.abs(currentFirstSize - targetFirstSize) < 0.05) {
      return;
    }
    groupRef.current?.setLayout({
      [firstPanelId]: targetFirstSize,
      [secondPanelId]: 100 - targetFirstSize,
    });
  }, [controlledSplit, firstPanelId, secondPanelId]);

  return (
    <ResizablePanelGroup
      id={groupId}
      groupRef={groupRef}
      orientation={direction}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
      resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}
      data-direction={direction}
      className={cn('isolate overflow-hidden', className)}
    >
      <ResizablePanel
        id={firstPanelId}
        minSize={minWidth}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {left}
      </ResizablePanel>
      {/* Terminal panes use z-10 status/inactive masks; the divider's 3px
          indicator crosses the 1px gutter and must paint above those masks.
          A horizontal divider overlaps the preceding pane by 1px so it does
          not push the following pane's tab strip down by a visible pixel. */}
      <ResizableHandle
        id={`${groupId}-divider`}
        data-slot="split-pane-divider"
        className={cn(
          'group z-20 bg-transparent shadow-none after:pointer-events-none after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-app-primary focus-visible:after:bg-app-primary data-[separator=active]:after:bg-app-primary',
          direction === 'vertical' && '-mt-px',
          dividerStyle === 'subtle' ? 'bg-app-border/15' : 'bg-app-border',
        )}
      />
      <ResizablePanel
        id={secondPanelId}
        minSize={minWidth}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {right}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};
