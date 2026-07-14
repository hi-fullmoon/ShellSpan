import { useCallback, useMemo } from 'react';
import { useToastStore } from '@/stores/toastStore';

interface UseToastResult {
  toast: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
}

export function useToast(): UseToastResult {
  const addToast = useToastStore((state) => state.addToast);

  const info = useCallback(
    (message: string, duration?: number): void => {
      addToast(message, 'info', duration);
    },
    [addToast],
  );

  const success = useCallback(
    (message: string, duration?: number): void => {
      addToast(message, 'success', duration);
    },
    [addToast],
  );

  const error = useCallback(
    (message: string, duration?: number): void => {
      addToast(message, 'error', duration);
    },
    [addToast],
  );

  return useMemo(
    () => ({ toast: info, info, success, error }),
    [error, info, success],
  );
}
