import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ArrowDownIcon, CheckIcon, CopyIcon } from 'lucide-react';
import {
  Bubble as BubblePrimitive,
  BubbleContent,
} from '@/components/ui/bubble';
import {
  Marker as MarkerPrimitive,
  MarkerContent,
} from '@/components/ui/marker';
import {
  Message as MessagePrimitive,
  MessageContent,
} from '@/components/ui/message';
import {
  MessageScroller as MessageScrollerPrimitive,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const MessageScroller: React.FC<{
  children: React.ReactNode;
  followKey: string;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
  initialAnchor?: { readonly nodeKey: string; readonly offset: number; readonly scrollTop: number };
  onAnchorChange?: (anchor: { readonly nodeKey: string; readonly offset: number; readonly scrollTop: number }) => void;
}> = ({
  children,
  followKey,
  className,
  contentClassName,
  ariaLabel,
  initialAnchor,
  onAnchorChange,
}) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(initialAnchor);
  const restoredAnchorRef = useRef<string | null>(null);
  const firstKey = React.Children.toArray(children).find((child) => React.isValidElement(child))?.key ?? null;
  const previousFirstKeyRef = useRef(firstKey);

  const viewport = useCallback(() => (
    rootRef.current?.querySelector<HTMLElement>('[data-message-scroller-viewport]') ?? null
  ), []);

  const readAnchor = useCallback(() => {
    const scrollport = viewport();
    if (!scrollport) return;
    const viewportTop = scrollport.getBoundingClientRect().top;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-ai-node-key]') ?? [];
    let selected: HTMLElement | null = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > viewportTop) {
        selected = row;
        break;
      }
    }
    if (!selected?.dataset.aiNodeKey) return;
    const next = {
      nodeKey: selected.dataset.aiNodeKey,
      offset: selected.getBoundingClientRect().top - viewportTop,
      scrollTop: scrollport.scrollTop,
    };
    anchorRef.current = next;
    onAnchorChange?.(next);
  }, [onAnchorChange, viewport]);

  useLayoutEffect(() => {
    const scrollport = viewport();
    if (!scrollport) return;
    const prepend = previousFirstKeyRef.current !== firstKey;
    previousFirstKeyRef.current = firstKey;
    const anchor = initialAnchor ?? (prepend ? anchorRef.current : undefined);
    if (!anchor) return;
    const restoreKey = `${anchor.nodeKey}:${anchor.offset}:${anchor.scrollTop}`;
    if (!prepend && restoredAnchorRef.current === restoreKey) return;
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-ai-node-key]') ?? [])]
      .find((candidate) => candidate.dataset.aiNodeKey === anchor.nodeKey);
    if (row) {
      scrollport.scrollTop += row.getBoundingClientRect().top
        - scrollport.getBoundingClientRect().top
        - anchor.offset;
    } else {
      scrollport.scrollTop = anchor.scrollTop;
    }
    restoredAnchorRef.current = restoreKey;
  }, [firstKey, initialAnchor, viewport]);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScrollerPrimitive
        ref={rootRef}
        className={className}
        data-follow-key={followKey}
        role="log"
        aria-label={ariaLabel}
      >
        <MessageScrollerViewport onScroll={readAnchor}>
          <MessageScrollerContent className={cn('gap-4 px-3 py-4', contentClassName)}>
            {React.Children.toArray(children).map((child, index) => {
              const itemKey = React.isValidElement(child) && child.key !== null
                ? child.key
                : index;
              return (
                <MessageScrollerItem
                  key={itemKey}
                  messageId={String(itemKey)}
                  scrollAnchor={
                    React.isValidElement<{ role?: string; scrollAnchor?: boolean }>(child)
                    && (child.props.scrollAnchor ?? child.props.role === 'user')
                  }
                >
                  {child}
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Tooltip>
          <TooltipTrigger render={<MessageScrollerButton aria-label={t('ai.scrollToLatest')} />}>
            <ArrowDownIcon />
          </TooltipTrigger>
          <TooltipContent>{t('ai.scrollToLatest')}</TooltipContent>
        </Tooltip>
      </MessageScrollerPrimitive>
    </MessageScrollerProvider>
  );
};

export const Message: React.FC<{
  role: 'user' | 'assistant';
  children: React.ReactNode;
}> = ({ role, children }) => {
  const { t } = useI18n();
  return (
    <MessagePrimitive
      align={role === 'user' ? 'end' : 'start'}
      className={cn('ai-message', `ai-message-${role}`)}
      role="article"
      aria-label={role === 'user' ? t('ai.message.user') : t('ai.message.assistant')}
    >
      <MessageContent className="ai-message-content">
        {children}
      </MessageContent>
    </MessagePrimitive>
  );
};

export const Bubble: React.FC<{
  role: 'user' | 'assistant';
  children: React.ReactNode;
}> = ({ role, children }) => (
  <BubblePrimitive
    align={role === 'user' ? 'end' : 'start'}
    variant={role === 'user' ? 'secondary' : 'ghost'}
    className={cn(
      'ai-message-bubble',
      `ai-message-bubble-${role}`,
      role === 'user'
        ? 'max-w-[84%] @max-[400px]/ai-workspace:max-w-[88%] @min-[560px]/ai-workspace:max-w-[80%]'
        : 'w-full max-w-full',
    )}
  >
    <BubbleContent
      className={cn(
        'ai-message-bubble-content',
        role === 'user'
          ? 'whitespace-pre-wrap'
          : 'w-full',
      )}
    >
      {children}
    </BubbleContent>
  </BubblePrimitive>
);

export const Marker: React.FC<{
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof MarkerPrimitive>['variant'];
}> = ({ children, variant = 'default' }) => (
  <MarkerPrimitive variant={variant}>
    <MarkerContent className={cn('ai-flow-marker', variant === 'default' && 'w-full')}>
      {children}
    </MarkerContent>
  </MarkerPrimitive>
);

export const MessageActions: React.FC<{
  text: string;
  align: 'start' | 'end';
  timestamp?: string;
  className?: string;
}> = ({ text, align, timestamp, className }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copy = useCallback(() => {
    if (copied || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_000);
    }).catch(() => undefined);
  }, [copied, text]);

  const time = timestamp === undefined
    ? null
    : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
      .format(new Date(timestamp));

  return (
    <div
      className={cn('ai-message-actions', className)}
      data-align={align}
      data-actions-reveal="hover"
    >
      {align === 'end' && time && <time dateTime={timestamp}>{time}</time>}
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              type="button"
              variant="plain"
              size="icon"
              className="ai-message-action"
              aria-label={copied ? t('common.copied') : t('common.copy')}
              onClick={copy}
            />
          )}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </TooltipTrigger>
        <TooltipContent>{copied ? t('common.copied') : t('common.copy')}</TooltipContent>
      </Tooltip>
      {align === 'start' && time && <time dateTime={timestamp}>{time}</time>}
      <span className="sr-only" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </div>
  );
};
