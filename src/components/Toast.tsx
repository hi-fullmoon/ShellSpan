import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/ui';
import { CloseIcon } from './Icons';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastProps {
  action?: ToastAction;
  durationMs?: number;
  message: string;
  onClose: () => void;
  open: boolean;
  tone?: 'success' | 'error' | 'info';
}

function toastTone(tone: NonNullable<ToastProps['tone']>) {
  switch (tone) {
    case 'success':
      return 'themed-toast-success';
    case 'error':
      return 'themed-toast-error';
    case 'info':
      return 'themed-toast-info';
  }
}

export function Toast({ action, durationMs = 2600, message, onClose, open, tone = 'info' }: ToastProps) {
  const [paused, setPaused] = useState(false);
  const [remainingMs, setRemainingMs] = useState(durationMs);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setPaused(false);
      setRemainingMs(durationMs);
      startedAtRef.current = null;
      return;
    }
  }, [durationMs, open]);

  useEffect(() => {
    if (!open || paused) {
      return;
    }

    startedAtRef.current = Date.now();
    const timer = window.setTimeout(onClose, remainingMs);
    return () => window.clearTimeout(timer);
  }, [onClose, open, paused, remainingMs]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed left-1/2 top-2 z-70 flex max-w-sm -translate-x-1/2">
      <div
        className={cn('themed-toast pointer-events-auto flex min-w-55 items-center gap-2 rounded-lg border px-3 py-2 backdrop-blur', toastTone(tone))}
        onMouseEnter={() => {
          if (startedAtRef.current !== null) {
            const elapsed = Date.now() - startedAtRef.current;
            setRemainingMs((current) => Math.max(0, current - elapsed));
          }
          startedAtRef.current = null;
          setPaused(true);
        }}
        onMouseLeave={() => {
          setPaused(false);
        }}
        role="status"
      >
        <span className="min-w-0 flex-1 text-xs">{message}</span>
        {action ? (
          <button className="themed-toast-button rounded-md px-2 py-1 text-[11px] transition" onClick={action.onClick} type="button">
            {action.label}
          </button>
        ) : null}
        <button aria-label="关闭提示" className="themed-toast-button rounded-md px-1 py-1 text-[11px] transition" onClick={onClose} type="button">
          <CloseIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}
