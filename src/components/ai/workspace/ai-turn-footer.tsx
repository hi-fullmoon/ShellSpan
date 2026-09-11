import type { ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Clock3Icon, DatabaseIcon } from 'lucide-react';

import { MessageActions } from '@/components/ai/chat-primitives';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { LocaleKey } from '@/locales';

type Translate = ReturnType<typeof useI18n>['t'];
type FooterLabel = Extract<LocaleKey, `ai.workspace.turnFooter.${string}`> extends
  `ai.workspace.turnFooter.${infer Key}` ? Key : never;

function duration(milliseconds: number, t: Translate): string {
  const seconds = milliseconds < 10_000
    ? Math.round(milliseconds / 100) / 10
    : Math.round(milliseconds / 1_000);
  return seconds < 60
    ? t('ai.workspace.duration.seconds', { seconds })
    : t('ai.workspace.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function compactTokens(value: number): string {
  const unit = value >= 999_500 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  const scaled = value / unit;
  const count = unit === 1 || scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${count}${unit === 1_000_000 ? 'M' : unit === 1_000 ? 'K' : ''}`;
}

function StatDetail({ stat, label, value }: {
  readonly stat: string;
  readonly label: string;
  readonly value: ReactNode;
}) {
  if (value === null || value === undefined) return null;
  return <div className="flex items-baseline justify-between gap-3" data-stat={stat}>
    <dt className="shrink-0">{label}</dt>
    <dd className="m-0 min-w-0 text-right [overflow-wrap:anywhere] [&_span]:block">{value}</dd>
  </div>;
}

function StatPopover({ icon, label, title, total, children }: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly title: string;
  readonly total?: string;
  readonly children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button type="button" variant="plain" size="sm" className="ai-turn-stat-trigger h-7 gap-[5px] px-[7px]" />}
      >
        {icon}<span>{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup className="ai-turn-stat-panel max-h-[var(--available-height)] w-[300px] max-w-[calc(100vw-16px)] overflow-auto px-[15px] py-3" initialFocus={false}>
            <div className="ai-turn-stat-heading mb-2.5 flex items-center justify-between gap-3">
              <Popover.Title className="m-0 flex items-center gap-1.5">{icon}<span>{title}</span></Popover.Title>
              {total && <strong className="whitespace-nowrap">{total}</strong>}
            </div>
            <Separator className="-mx-1 w-[calc(100%+8px)]" />
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AiTurnFooter({ node }: { readonly node: AiConversationNodeOf<'turnTail'> }) {
  const { t, locale } = useI18n();
  const { stats } = node;
  const label = (key: FooterLabel): string => (
    t(`ai.workspace.turnFooter.${key}`)
  );
  const tokens = (value: number | null): string | null => value === null
    ? null : `${value.toLocaleString(locale)} tok`;
  const time = (value: number | null | undefined): string | null => value == null ? null : duration(value, t);
  const totalTime = time(node.durationMs);
  const input = stats.uncachedInputTokens !== null && stats.cacheReadTokens !== null
    && stats.cacheWriteTokens !== null
    ? stats.uncachedInputTokens + stats.cacheReadTokens + stats.cacheWriteTokens : null;
  const cacheHit = input !== null && input > 0 && stats.cacheReadTokens !== null
    ? `${((stats.cacheReadTokens / input) * 100).toFixed(1)}%` : null;
  const hasUsage = [stats.totalTokens, stats.uncachedInputTokens, stats.cacheReadTokens,
    stats.cacheWriteTokens, stats.outputTokens, stats.reasoningTokens].some((value) => value !== null);
  const hasTiming = [node.durationMs, stats.modelDurationMs, stats.toolDurationMs,
    stats.averageTimeToFirstTokenMs, stats.tokensPerSecond].some((value) => value != null);

  return (
    <div className="ai-turn-tail min-w-0 max-w-full" data-status={node.status} data-stop-reason={node.stopReason ?? undefined}
      aria-label={t('ai.workspace.stats.label')}>
      <MessageActions text={node.summaryText ?? ''} timestamp={node.timestamp} align="start"
        reveal="always"
        className="ai-turn-stats h-auto min-h-7 w-full min-w-0 max-w-full flex-wrap gap-x-1.5 gap-y-0.5 overflow-visible [&_time]:ml-0.5"
        actionClassName="ai-turn-stat-trigger h-7 gap-[5px] overflow-hidden px-[7px]">
        {hasUsage && (
          <StatPopover icon={<DatabaseIcon aria-hidden="true" />} title={label('usageTitle')}
            label={t('ai.workspace.turnFooter.usage', {
              count: stats.totalTokens === null ? '—' : `${compactTokens(stats.totalTokens)} tok`,
            })} total={tokens(stats.totalTokens) ?? undefined}>
            <dl className="ai-turn-stat-details mt-2.5 mb-0.5 grid gap-[7px]">
              {!!node.models?.length && <StatDetail stat="models" label={label('models')}
                value={node.models.map(({ providerId, model }) => (
                  <span key={JSON.stringify([providerId, model])}>{providerId}/{model}</span>
                ))} />}
              <StatDetail stat="cacheHit" label={label('cacheHit')} value={cacheHit} />
              <StatDetail stat="uncachedInput" label={label('uncachedInput')} value={tokens(stats.uncachedInputTokens)} />
              <StatDetail stat="cacheRead" label={label('cacheRead')} value={tokens(stats.cacheReadTokens)} />
              {!!stats.cacheWriteTokens && <StatDetail stat="cacheWrite" label={label('cacheWrite')} value={tokens(stats.cacheWriteTokens)} />}
              <StatDetail stat="outputTokens" label={label('output')} value={tokens(stats.outputTokens)} />
              {!!stats.reasoningTokens && <StatDetail stat="reasoningTokens" label={label('reasoning')} value={tokens(stats.reasoningTokens)} />}
            </dl>
            {!stats.usageComplete && <p className="ai-turn-stat-note mt-2.5 mb-0">{label('partialUsage')}</p>}
          </StatPopover>
        )}
        {hasTiming && (
          <StatPopover icon={<Clock3Icon aria-hidden="true" />} title={label('timingTitle')}
            label={t('ai.workspace.turnFooter.elapsed', { duration: totalTime ?? '—' })}>
            <dl className="ai-turn-stat-details mt-2.5 mb-0.5 grid gap-[7px]">
              <StatDetail stat="duration" label={label('totalTime')} value={totalTime} />
              <StatDetail stat="rate" label={label('rate')} value={stats.tokensPerSecond === null
                ? null : `${Number(stats.tokensPerSecond.toFixed(1))} tok/s`} />
              <StatDetail stat="ttft" label={label(stats.timeToFirstTokenCount > 1 ? 'ttftAverage' : 'ttft')}
                value={time(stats.averageTimeToFirstTokenMs)} />
            </dl>
            <Separator className="-mx-1 mt-2.5 w-[calc(100%+8px)]" />
            <dl className="ai-turn-stat-details ai-turn-stat-secondary mt-2.5 mb-0.5 grid gap-[7px]">
              <StatDetail stat="model" label={label('modelTime')} value={time(stats.modelDurationMs)} />
              <StatDetail stat="tools" label={label('toolTime')} value={time(stats.toolDurationMs)} />
              <StatDetail stat="steps" label={label('steps')} value={stats.stepCount.toLocaleString(locale)} />
            </dl>
          </StatPopover>
        )}
      </MessageActions>
    </div>
  );
}
