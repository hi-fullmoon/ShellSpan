import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  content: string;
  x: number;
  y: number;
  visible: boolean;
}

interface TooltipContextValue {
  show: (content: string, x: number, y: number) => void;
  hide: () => void;
  move: (x: number, y: number) => void;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

const TOOLTIP_OFFSET_X = 6;
const TOOLTIP_OFFSET_Y = 8;
const VIEWPORT_EDGE = 8;

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TooltipState>({
    content: '',
    x: 0,
    y: 0,
    visible: false,
  });
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const moveRafRef = useRef<number | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  const clampPosition = useCallback(
    (x: number, y: number, width: number, height: number) => {
      let clampedX = x + TOOLTIP_OFFSET_X;
      let clampedY = y + TOOLTIP_OFFSET_Y;

      if (clampedX + width > window.innerWidth - VIEWPORT_EDGE) {
        clampedX = x - width - TOOLTIP_OFFSET_X;
      }
      if (clampedX < VIEWPORT_EDGE) {
        clampedX = VIEWPORT_EDGE;
      }
      if (clampedY + height > window.innerHeight - VIEWPORT_EDGE) {
        clampedY = y - height - TOOLTIP_OFFSET_Y;
      }
      if (clampedY < VIEWPORT_EDGE) {
        clampedY = VIEWPORT_EDGE;
      }

      return { x: clampedX, y: clampedY };
    },
    [],
  );

  const show = useCallback((content: string, x: number, y: number) => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }

    // 如果 tooltip 已经在显示，直接更新内容，不需要等待延迟
    if (stateRef.current.visible) {
      setState((prev) => ({ ...prev, content }));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = tooltipRef.current;
          const width = el?.offsetWidth ?? 0;
          const height = el?.offsetHeight ?? 0;
          const pos = clampPosition(x, y, width, height);
          setState((s) => ({ ...s, x: pos.x, y: pos.y, visible: true }));
        });
      });
      return;
    }

    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = undefined;
      // 先触发 content 渲染（此时可能还在视口外或尺寸不准，但 opacity 为 0 用户看不到）
      setState((prev) => ({ ...prev, content }));
      // 连续两次 rAF 确保 React commit + 浏览器布局完成后再读取真实尺寸
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = tooltipRef.current;
          const width = el?.offsetWidth ?? 0;
          const height = el?.offsetHeight ?? 0;
          const pos = clampPosition(x, y, width, height);
          setState((s) => ({ ...s, x: pos.x, y: pos.y, visible: true }));
        });
      });
    }, 2000);
  }, [clampPosition]);

  const hide = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = undefined;
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = undefined;
      setState((s) => ({ ...s, visible: false }));
    }, 200);
  }, []);

  const move = useCallback(
    (x: number, y: number) => {
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
      }
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = undefined;
        const el = tooltipRef.current;
        const width = el?.offsetWidth ?? 0;
        const height = el?.offsetHeight ?? 0;
        const pos = clampPosition(x, y, width, height);
        setState((s) => ({ ...s, x: pos.x, y: pos.y }));
      });
    },
    [clampPosition],
  );

  useEffect(() => {
    return () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
      }
    };
  }, []);

  return (
    <TooltipContext.Provider value={{ show, hide, move }}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            className="tooltip-bubble"
            style={{
              left: state.x,
              top: state.y,
              opacity: state.visible ? 1 : 0,
              pointerEvents: 'none',
            }}
          >
            {state.content}
          </div>,
          document.body,
        )}
    </TooltipContext.Provider>
  );
}

function useTooltip() {
  const ctx = useContext(TooltipContext);
  if (!ctx) {
    return {
      show: () => {},
      hide: () => {},
      move: () => {},
    };
  }
  return ctx;
}

interface TooltipProps {
  content: string;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  const { show, hide, move } = useTooltip();

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent) => {
      show(content, event.clientX, event.clientY);
    },
    [content, show],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      move(event.clientX, event.clientY);
    },
    [move],
  );

  const handleMouseLeave = useCallback(() => {
    hide();
  }, [hide]);

  useEffect(() => {
    return () => {
      hide();
    };
  }, [hide]);

  return (
    <span
      className="tooltip-trigger"
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </span>
  );
}
