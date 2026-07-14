import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
  placement?: 'top' | 'bottom';
}

const ARROW_SIZE = 6;

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className,
  placement = 'top',
}) => {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    top: -9999,
    left: -9999,
  });

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipHeight = tooltip?.offsetHeight ?? 24;
    const tooltipWidth = tooltip?.offsetWidth ?? 0;

    const top =
      placement === 'top'
        ? triggerRect.top - ARROW_SIZE - 2
        : triggerRect.bottom + ARROW_SIZE + 2;

    const left = triggerRect.left + triggerRect.width / 2;
    const halfWidth = tooltipWidth / 2;
    const minLeft = halfWidth + 8;
    const maxLeft = window.innerWidth - halfWidth - 8;
    const adjustedLeft = Math.max(minLeft, Math.min(maxLeft, left));

    setStyle({
      top,
      left: adjustedLeft,
    });
  }, [placement]);

  useEffect(() => {
    if (!visible) return;

    updatePosition();

    const handleScroll = (): void => {
      updatePosition();
    };

    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [visible, updatePosition]);

  const show = useCallback((): void => {
    setVisible(true);
  }, []);

  const hide = useCallback((): void => {
    setVisible(false);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={cn(
              'fixed z-[100] -translate-x-1/2 rounded-lg border border-app-border bg-app-surface px-2.5 py-1 text-xs text-app-text shadow-lg backdrop-blur-sm transition-opacity',
              placement === 'top' && '-translate-y-full',
            )}
            style={style}
          >
            {content}
            <span
              className={cn(
                'absolute left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border border-app-border bg-app-surface',
                placement === 'top' && 'bottom-[-5px] border-l-0 border-t-0',
                placement === 'bottom' && 'top-[-5px] border-r-0 border-b-0',
              )}
            />
          </div>,
          document.body,
        )}
    </>
  );
};
