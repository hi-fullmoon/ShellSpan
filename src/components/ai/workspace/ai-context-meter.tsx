import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [placement, setPlacement] = useState<{ left: number; bottom: number; width: number }>();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const available = usage !== undefined
    && Number.isFinite(usage.usedTokens)
    && usage.usedTokens >= 0
    && Number.isFinite(usage.contextWindow)
    && usage.contextWindow > 0;

  useEffect(() => {
    if (!available && open) setOpen(false);
  }, [available, open]);

  const updatePlacement = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = Math.max(window.innerWidth, 16);
    const width = Math.min(264, viewportWidth - 16);
    setPlacement({
      left: Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open || !available) return undefined;
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [available, open, updatePlacement]);

  useEffect(() => {
    if (!open || !available) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node
        && (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
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
    <span ref={rootRef} className="ai-context-meter">
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              ref={triggerRef}
              type="button"
              className="ai-context-meter-trigger"
              aria-label={ariaLabel}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
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
      {open && placement && createPortal((
        <div
          ref={panelRef}
          className="ai-context-meter-panel"
          role="dialog"
          aria-label={t('ai.workspace.contextUsage.title')}
          style={placement}
        >
          <div className="ai-context-meter-header">
            <span>{t('ai.workspace.contextUsage.used')}</span>
            <strong>{percent}%</strong>
            <span className="ai-context-meter-figures">
              ~{formatTokens(usage.usedTokens)} / {formatTokens(usage.contextWindow)}
            </span>
          </div>
          <div className="ai-context-meter-bar" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.key}
                data-color={segment.color}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {usage.breakdown && (
            <dl className="ai-context-meter-rows">
              {BREAKDOWN_ROWS.map((row) => (
                <div key={row.key}>
                  <dt>
                    <span data-color={row.color} aria-hidden="true" />
                    {t(row.label)}
                  </dt>
                  <dd>~{formatTokens(usage.breakdown![row.key])}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="ai-context-meter-note">
            {t(usage.source === 'reported'
              ? 'ai.workspace.contextUsage.reportedNote'
              : 'ai.workspace.contextUsage.estimatedNote')}
          </p>
        </div>
      ), document.body)}
    </span>
  );
}
