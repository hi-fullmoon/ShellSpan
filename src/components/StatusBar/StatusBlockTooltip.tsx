import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/ui';
import type { StatusBlockTooltipData } from './types';

interface StatusBlockTooltipProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  data: StatusBlockTooltipData;
}

export function StatusBlockTooltip({ open, anchorRef, data }: StatusBlockTooltipProps) {
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    if (!open || !anchorRef.current) return;

    const updateCoords = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      setCoords({
        left: rect.left + rect.width / 2,
        top: rect.top,
      });
    };

    updateCoords();

    window.addEventListener('scroll', updateCoords, { passive: true });
    window.addEventListener('resize', updateCoords);

    return () => {
      window.removeEventListener('scroll', updateCoords);
      window.removeEventListener('resize', updateCoords);
    };
  }, [open, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        'fixed z-[1700] max-w-[240px] -translate-x-1/2 -translate-y-full rounded-md px-2.5 py-2 text-xs',
        'border shadow-lg',
      )}
      style={{
        left: coords.left,
        top: coords.top - 6,
        background: 'var(--app-panel-primary)',
        borderColor: 'var(--app-border)',
        color: 'var(--app-text)',
      }}
      role="tooltip"
    >
      <div className="font-medium">{data.title}</div>
      {data.subtitle ? <div className="mt-0.5 text-subtle">{data.subtitle}</div> : null}
      {data.detail ? <div className="mt-0.5">{data.detail}</div> : null}
      {data.errorMessage ? <div className="mt-1 text-rose-300">{data.errorMessage}</div> : null}
      {data.action ? (
        <button
          type="button"
          className="mt-2 w-full rounded border px-2 py-1 text-xs hover:opacity-80 disabled:opacity-50"
          onClick={data.action.onClick}
          disabled={data.action.disabled}
          style={{ borderColor: 'var(--app-border)', color: 'var(--app-text)' }}
        >
          {data.action.label}
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
