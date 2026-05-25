import { useEffect, useRef } from 'react';
import { createToaster } from '@chakra-ui/react';

export const toaster = createToaster({
  placement: 'top',
  overlap: true,
  gap: 8,
});

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

export function Toast({ action, durationMs = 2600, message, onClose, open, tone = 'info' }: ToastProps) {
  const toastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      const id = toaster.create({
        title: message,
        type: tone,
        duration: durationMs,
        action: action
          ? {
              label: action.label,
              onClick: action.onClick,
            }
          : undefined,
      });
      toastIdRef.current = id;

      const timer = window.setTimeout(() => {
        onClose();
      }, durationMs);

      return () => {
        window.clearTimeout(timer);
        toaster.dismiss(id);
        toastIdRef.current = null;
      };
    }

    return undefined;
  }, [open, message, tone, durationMs, action, onClose]);

  return null;
}
