import { createContext, useContext, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { AiFailureRecovery } from '@/lib/ai/failure-recovery';

export const AiFailureRecoveryContext = createContext<{
  recovery: AiFailureRecovery | null;
  busy: boolean;
  onRetry?: (turnId: string) => void;
  onSettings?: () => void;
} | null>(null);

export function AiFailureRecoveryAction({ turnId }: { readonly turnId: string | null }): React.ReactNode {
  const context = useContext(AiFailureRecoveryContext);
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const recovery = context?.recovery?.turnId === turnId ? context.recovery : null;
  const retryAt = recovery?.kind === 'retry' ? recovery.retryAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (retryAt === undefined || retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  if (!context || !recovery) return null;
  if (recovery.kind === 'verify' || recovery.kind === 'input') {
    return <span className="block text-muted-foreground">{t(recovery.kind === 'verify' ? 'ai.error.recovery.verify' : 'ai.error.recovery.input')}</span>;
  }
  if (recovery.kind === 'settings') {
    return context.onSettings && <Button type="button" variant="ghost" size="xs" disabled={context.busy} onClick={context.onSettings}>
      {t('ai.error.recovery.settings')}
    </Button>;
  }
  if (!context.onRetry) return null;
  const seconds = Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1000));
  return <Button type="button" variant="ghost" size="xs" disabled={context.busy || seconds > 0}
    aria-busy={context.busy || undefined} onClick={() => context.onRetry?.(recovery.turnId)}>
    {context.busy ? t('ai.error.recovery.retrying') : seconds > 0 ? t('ai.error.recovery.cooldown', { seconds }) : t('common.retry')}
  </Button>;
}
