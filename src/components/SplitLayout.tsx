import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/ui';

type SplitDirection = 'horizontal' | 'vertical';

interface SlotRenderProps {
  collapsed: boolean;
  size: number;
}

interface SlotConfig {
  name: string;
  className?: string;
  children: ReactNode | ((props: SlotRenderProps) => ReactNode);
  collapsed?: boolean;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  fixed?: boolean;
}

interface SplitLayoutContextValue {
  direction: SplitDirection;
  getSlotState: (name: string) => SlotRenderProps | undefined;
}

const SplitLayoutContext = createContext<SplitLayoutContextValue | null>(null);

function useSplitLayout() {
  const ctx = useContext(SplitLayoutContext);
  if (!ctx) throw new Error('SplitLayout.Slot must be used inside SplitLayout');
  return ctx;
}

function Slot(props: SlotConfig) {
  const ctx = useSplitLayout();
  const state = ctx.getSlotState(props.name);
  if (!state) return null;

  return <>{typeof props.children === 'function' ? props.children(state) : props.children}</>;
}

interface SplitLayoutProps {
  className?: string;
  direction?: SplitDirection;
  storageKey?: string;
  children: ReactElement<SlotConfig> | ReactElement<SlotConfig>[];
}

const SASH_SIZE = 0;

function readStoredSize(storageKey: string | undefined, fallback: number) {
  if (!storageKey || typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function collectSlots(children: ReactElement<SlotConfig> | ReactElement<SlotConfig>[]) {
  const slots: ReactElement<SlotConfig>[] = [];
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    if (child && child.type === Slot) {
      slots.push(child);
    }
  }
  return slots;
}

export function SplitLayout({ className, direction = 'horizontal', storageKey, children }: SplitLayoutProps) {
  const slots = collectSlots(children);
  if (slots.length > 2) {
    throw new Error('SplitLayout accepts at most 2 Slot children');
  }

  const firstProps = slots[0]?.props;
  const secondProps = slots[1]?.props;

  const firstDefaultSize = firstProps?.defaultSize ?? 240;
  const firstMinSize = firstProps?.minSize ?? 0;
  const firstMaxSize = firstProps?.maxSize;
  const firstCollapsed = firstProps?.collapsed ?? false;
  const firstFixed = firstProps?.fixed ?? false;

  const secondDefaultSize = secondProps?.defaultSize ?? 240;
  const secondMinSize = secondProps?.minSize ?? 0;
  const secondMaxSize = secondProps?.maxSize;
  const secondCollapsed = secondProps?.collapsed ?? false;
  const secondFixed = secondProps?.fixed ?? false;

  // 哪个 slot 是固定的；undefined 表示两者都弹性（由拖拽决定比例）
  const fixedSlot = firstFixed ? ('first' as const) : secondFixed ? ('second' as const) : undefined;

  // 哪个 slot 的大小由 state 控制（即可拖拽调整的）
  const controlledSlot = fixedSlot === 'second' ? ('second' as const) : ('first' as const);
  const controlledDefaultSize = controlledSlot === 'first' ? firstDefaultSize : secondDefaultSize;
  const controlledMinSize = controlledSlot === 'first' ? firstMinSize : secondMinSize;
  const controlledMaxSize = controlledSlot === 'first' ? firstMaxSize : secondMaxSize;
  const otherMinSize = controlledSlot === 'first' ? secondMinSize : firstMinSize;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [controlledSize, setControlledSize] = useState(() => readStoredSize(storageKey, controlledDefaultSize));
  const [dragging, setDragging] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // 当 defaultSize 变化时更新（仅当无 storageKey）
  useEffect(() => {
    if (!storageKey) {
      setControlledSize(controlledDefaultSize);
    }
  }, [controlledDefaultSize, storageKey]);

  const clampSize = (nextSize: number, containerSize: number) => {
    const available = Math.max(controlledMinSize, containerSize - otherMinSize - SASH_SIZE);
    const maxSize = controlledMaxSize !== undefined ? Math.min(controlledMaxSize, available) : available;
    return Math.max(controlledMinSize, Math.min(nextSize, maxSize));
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      const containerSize = direction === 'horizontal' ? element.clientWidth : element.clientHeight;
      if (containerSize <= 0) {
        return;
      }

      if (fixedSlot) {
        // 有固定面板时，不需要随容器 resize 调整 controlledSize
        return;
      }

      setControlledSize((current) => clampSize(current, containerSize));
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [direction, controlledMaxSize, controlledMinSize, otherMinSize, fixedSlot]);

  useEffect(() => {
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, String(controlledSize));
    }
  }, [controlledSize, storageKey]);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const element = containerRef.current;
    const sash = event.currentTarget;
    if (!element) {
      return;
    }

    event.preventDefault();
    sash.setPointerCapture(event.pointerId);

    const startPosition = direction === 'horizontal' ? event.clientX : event.clientY;
    const startSize = controlledSize;
    const containerSize = direction === 'horizontal' ? element.clientWidth : element.clientHeight;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);

    const handleMove = (moveEvent: PointerEvent) => {
      const currentPosition = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const rawDelta = currentPosition - startPosition;
      // controlledSlot 在右侧时，拖拽方向与尺寸变化方向相反
      const delta = controlledSlot === 'second' ? -rawDelta : rawDelta;
      setControlledSize(clampSize(startSize + delta, containerSize));
    };

    let ended = false;

    const stopDrag = () => {
      if (ended) return;
      ended = true;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      sash.removeEventListener('lostpointercapture', stopDrag);
      try {
        sash.releasePointerCapture(event.pointerId);
      } catch {
        // capture 可能已经被浏览器释放
      }
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = stopDrag;

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    sash.addEventListener('lostpointercapture', stopDrag);
  };

  const getContainerSize = () => {
    const element = containerRef.current;
    if (!element) return 0;
    return direction === 'horizontal' ? element.clientWidth : element.clientHeight;
  };

  const getSlotState = (name: string): SlotRenderProps | undefined => {
    const containerSize = getContainerSize();

    if (name === firstProps?.name) {
      if (fixedSlot === 'second') {
        const size = Math.max(0, containerSize - controlledSize - SASH_SIZE);
        return { size, collapsed: firstCollapsed };
      }
      return { size: controlledSize, collapsed: firstCollapsed };
    }

    if (name === secondProps?.name) {
      if (fixedSlot === 'second') {
        return { size: controlledSize, collapsed: secondCollapsed };
      }
      const size = Math.max(0, containerSize - controlledSize - SASH_SIZE);
      return { size, collapsed: secondCollapsed };
    }

    return undefined;
  };

  const showSash = !firstCollapsed && !secondCollapsed;

  // 第一面板样式
  const firstStyle = firstCollapsed
    ? { display: 'none' as const }
    : fixedSlot === 'second'
      ? undefined // second 固定时，first 弹性填充
      : direction === 'horizontal'
        ? { width: controlledSize, minWidth: controlledSize, maxWidth: controlledSize }
        : { height: controlledSize, minHeight: controlledSize, maxHeight: controlledSize };

  // 第二面板样式
  const secondStyle = secondCollapsed
    ? { display: 'none' as const }
    : fixedSlot === 'second'
      ? direction === 'horizontal'
        ? { width: controlledSize, minWidth: controlledSize, maxWidth: controlledSize }
        : { height: controlledSize, minHeight: controlledSize, maxHeight: controlledSize }
      : undefined; // 弹性填充

  return (
    <SplitLayoutContext.Provider value={{ direction, getSlotState }}>
      <div
        className={cn(
          'split-layout',
          direction === 'horizontal' ? 'flex h-full min-w-0 flex-1' : 'flex h-full min-h-0 flex-1 flex-col',
          className,
        )}
        ref={containerRef}
      >
        {/* 第一面板 */}
        {slots[0] && !firstCollapsed && (
          <div
            className={cn(
              'grid h-full min-h-0 overflow-hidden',
              fixedSlot === 'second' && 'min-w-0 flex-1',
              fixedSlot !== 'first' && fixedSlot !== 'second' && 'shrink-0',
              firstProps?.className,
            )}
            style={firstStyle}
          >
            <Slot {...firstProps} />
          </div>
        )}

        {/* Sash */}
        {showSash && (
          <button
            aria-label={direction === 'horizontal' ? '调整左右区域宽度' : '调整上下区域高度'}
            className={cn(
              'split-sash',
              dragging && 'split-sash-active',
              direction === 'horizontal' ? 'split-sash-horizontal' : 'split-sash-vertical',
            )}
            onPointerDown={startDrag}
            type="button"
          >
            <span className="split-sash-line" />
          </button>
        )}

        {/* 第二面板 */}
        {slots[1] && !secondCollapsed && (
          <div
            className={cn(
              'grid h-full min-h-0 overflow-hidden',
              fixedSlot !== 'second' && 'min-w-0 flex-1',
              secondProps?.className,
            )}
            style={secondStyle}
          >
            <Slot {...secondProps} />
          </div>
        )}
      </div>
    </SplitLayoutContext.Provider>
  );
}

SplitLayout.Slot = Slot;

export type { SlotConfig as SplitSlotProps, SlotRenderProps };
