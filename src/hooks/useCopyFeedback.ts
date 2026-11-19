import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/hooks/useI18n';
import { writeClipboardText } from '@/lib/clipboard';

export type CopySource = string | (() => string | Promise<string>);
export type CopyAction = () => void | boolean | Promise<void | boolean>;

export function useCopyFeedback(errorLabel?: string) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback(async (action: CopyAction): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      if (await action() === false) { busy.current = false; return false; }
      if (!active.current) return false;
      setCopied(true);
      timer.current = setTimeout(() => {
        busy.current = false;
        setCopied(false);
      }, 1_000);
      return true;
    } catch {
      busy.current = false;
      if (active.current) toast.error(errorLabel ?? t('common.copyFailed'));
      return false;
    }
  }, [errorLabel, t]);

  const copy = useCallback((source: CopySource): Promise<boolean> => run(async () => {
    const text = typeof source === 'string' ? source : await source();
    if (!active.current) return false;
    await writeClipboardText(text);
  }), [run]);

  return { copied, copy, run };
}
