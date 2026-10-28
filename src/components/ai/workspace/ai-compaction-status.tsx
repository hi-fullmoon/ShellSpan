import { useEffect, useState } from 'react';
import { CheckIcon, CircleAlertIcon, SquareIcon } from 'lucide-react';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';

export function AiCompactionStatus({ node }: { readonly node: AiConversationNodeOf<'compaction'> }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const active = node.state === 'running';
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, node.compactionId]);
  const elapsed = active && node.startedAtUnixMs !== null
    ? Math.max(0, now - node.startedAtUnixMs) : node.durationMs;
  const seconds = elapsed === null ? null : Math.floor(elapsed / 1_000);
  const time = seconds === null ? null : seconds < 60
    ? t('ai.workspace.duration.seconds', { seconds })
    : t('ai.workspace.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  const Icon = node.state === 'completed' ? CheckIcon : node.state === 'failed' ? CircleAlertIcon : SquareIcon;
  return <Marker className="ai-turn-status min-h-6 min-w-0 max-w-full gap-1" role="status" aria-live="polite"
    data-ai-compaction-status={node.state} aria-busy={active}>
    <MarkerIcon>{active ? <Spinner aria-hidden="true" /> : <Icon aria-hidden="true" />}</MarkerIcon>
    <MarkerContent className={active ? 'shimmer' : undefined}>{t(`ai.workspace.compaction.${node.state}`)}</MarkerContent>
    {time !== null && <small className="shrink-0" aria-live="off" data-ai-compaction-duration="">
      {t(active ? 'ai.workspace.compaction.elapsed' : 'ai.workspace.compaction.duration', { time })}
    </small>}
  </Marker>;
}
