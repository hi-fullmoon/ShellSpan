import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

/** Keep truncation on the inner span: WebKit does not clamp native buttons. */
export function AiContentTitle({ children, className, buttonClassName, expandLabel, collapseLabel, collapsible = false }: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly buttonClassName?: string;
  readonly expandLabel?: string;
  readonly collapseLabel?: string;
  readonly collapsible?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    let disposed = false;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setOverflow(element.scrollHeight > lineHeight * 2 + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    return () => { disposed = true; observer.disconnect(); };
  }, [children, overflow]);
  const interactive = collapsible || overflow;
  const text = <span ref={textRef} className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', expanded ? 'block' : 'line-clamp-2')}>{children}</span>;
  return (
    <span className={cn('ai-content-title block min-w-0', expanded && 'max-h-[6lh] overflow-auto overscroll-contain', className)} data-expanded={expanded}>
      {interactive ? <button
        type="button"
        className={cn('block w-full min-w-0 cursor-pointer p-0 text-left whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', buttonClassName)}
        aria-expanded={expanded}
        aria-label={expanded ? collapseLabel ?? t('ai.workspace.tool.collapseTitle') : expandLabel ?? t('ai.workspace.tool.expandTitle')}
        onClick={() => setExpanded(value => !value)}
      >
        {text}
      </button> : text}
    </span>
  );
}
