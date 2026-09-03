import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { ArrowDownIcon } from 'lucide-react';
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
          <MessageScrollerContent className={cn('gap-5 px-3 py-4', contentClassName)}>
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
      role="article"
      aria-label={role === 'user' ? t('ai.message.user') : t('ai.message.assistant')}
    >
      <MessageContent>
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
      role === 'user'
        ? 'max-w-[84%] @max-[400px]/ai-workspace:max-w-[88%] @min-[560px]/ai-workspace:max-w-[80%]'
        : 'w-full max-w-full',
    )}
  >
    <BubbleContent
      className={cn(
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
    <MarkerContent className={cn(variant === 'default' && 'w-full text-center')}>
      {children}
    </MarkerContent>
  </MarkerPrimitive>
);
