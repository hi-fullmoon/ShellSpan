import { useEffect, useState } from 'react';

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiContextUsage } from '@/lib/ai/session-adapter';

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const BREAKDOWN_ROWS = [
  { key: 'systemTokens', label: 'ai.workspace.contextUsage.system', color: 'system' },
  { key: 'toolsTokens', label: 'ai.workspace.contextUsage.tools', color: 'tools' },
  { key: 'messageTokens', label: 'ai.workspace.contextUsage.messages', color: 'messages' },
] as const;

function formatTokens(value: number): string {
  const scaled = (candidate: number): string => {
    const rounded = candidate >= 100 ? Math.round(candidate) : Math.round(candidate * 10) / 10;
    return String(rounded);
  };
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

export function AiContextMeter({ usage }: { readonly usage?: AiContextUsage }): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const available = usage !== undefined
    && Number.isFinite(usage.usedTokens)
    && usage.usedTokens >= 0
    && Number.isFinite(usage.contextWindow)
    && usage.contextWindow > 0;

  useEffect(() => {
    if (!available && open) setOpen(false);
  }, [available, open]);

  if (!available || !usage) return null;
  const percent = Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100));
  const ariaLabel = t(
    usage.source === 'reported'
      ? 'ai.workspace.contextUsage.reportedAria'
      : 'ai.workspace.contextUsage.estimatedAria',
    { percent },
  );
  const breakdownTotal = usage.breakdown
    ? usage.breakdown.systemTokens + usage.breakdown.toolsTokens + usage.breakdown.messageTokens
    : 0;
  const segments = usage.breakdown && breakdownTotal > 0
    ? BREAKDOWN_ROWS.map((row) => ({
        key: row.key,
        color: row.color,
        width: percent * usage.breakdown![row.key] / breakdownTotal,
      })).filter((segment) => segment.width > 0)
    : percent > 0
      ? [{ key: 'total', color: 'total', width: percent }]
      : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="ai-context-meter relative inline-flex shrink-0">
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              render={<button type="button" className="ai-context-meter-trigger grid size-7 shrink-0 cursor-pointer place-items-center p-0" />}
              aria-label={ariaLabel}
            />
          )}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle className="ai-context-meter-track" cx="7" cy="7" r={RADIUS} />
            <circle
              className="ai-context-meter-fill"
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent>{ariaLabel}</TooltipContent>
      </Tooltip>
      </span>
        <PopoverContent
          side="top" align="end" sideOffset={8} collisionPadding={8}
          className="ai-context-meter-panel block w-[264px] max-w-[calc(100vw-16px)] max-h-(--available-height) overflow-y-auto overscroll-contain"
          aria-label={t('ai.workspace.contextUsage.title')}
        >
          <PopoverTitle className="sr-only">{t('ai.workspace.contextUsage.title')}</PopoverTitle>
          <div className="ai-context-meter-header flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <span>{t('ai.workspace.contextUsage.used')}</span>
            <strong>{percent}%</strong>
            <span className="ai-context-meter-figures ml-auto min-w-0 truncate">
              ~{formatTokens(usage.usedTokens)} / {formatTokens(usage.contextWindow)}
            </span>
          </div>
          <div className="ai-context-meter-bar mt-2 mb-2.5 flex h-1 gap-px overflow-hidden" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.key}
                data-color={segment.color}
                className="h-full min-w-0.5 shrink-0"
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {usage.breakdown && (
            <dl className="ai-context-meter-rows mt-1 mb-0">
              {BREAKDOWN_ROWS.map((row) => (
                <div className="flex items-center justify-between gap-3 py-0.5" key={row.key}>
                  <dt className="flex min-w-0 items-center gap-1">
                    <span className="size-2 shrink-0" data-color={row.color} aria-hidden="true" />
                    {t(row.label)}
                  </dt>
                  <dd className="m-0">~{formatTokens(usage.breakdown![row.key])}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="ai-context-meter-note mt-1.5 mb-0 pt-1.5">
            {t(usage.source === 'reported'
              ? 'ai.workspace.contextUsage.reportedNote'
              : 'ai.workspace.contextUsage.estimatedNote')}
          </p>
        </PopoverContent>
    </Popover>
  );
}
