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
  useMessageScroller,
} from '@/components/ui/message-scroller';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MessageScrollerProps {
  children: React.ReactNode;
  followKey: string;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
  initialAnchor?: { readonly nodeKey: string; readonly offset: number; readonly scrollTop: number };
  onAnchorChange?: (anchor: { readonly nodeKey: string; readonly offset: number; readonly scrollTop: number }) => void;
}

export const MessageScroller: React.FC<MessageScrollerProps> = (props) => {
  const openingAnchor = useRef(props.initialAnchor);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition={openingAnchor.current ? 'start' : 'end'}>
      <ConversationScroller {...props} initialAnchor={openingAnchor.current} />
    </MessageScrollerProvider>
  );
};

const ConversationScroller: React.FC<MessageScrollerProps> = ({
  children,
  followKey,
  className,
  contentClassName,
  ariaLabel,
  initialAnchor,
  onAnchorChange,
}) => {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const restoredAnchorRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);
  const { scrollToMessage, scrollToStart } = useMessageScroller();

  const cancelRestore = useCallback(() => {
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    cancelRestore();
    if (!(event.target instanceof Element)
      || !event.target.closest('[data-slot="scroll-area-scrollbar"]')) return;
    // The custom scrollbar sits outside the viewport. Notify the primitive's
    // existing wheel-intent handler with zero movement so dragging releases
    // auto-follow even during its programmatic-scroll grace period.
    viewportRef.current?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 0 }));
  }, [cancelRestore]);

  useEffect(() => cancelRestore, [cancelRestore]);

  const readAnchor = useCallback(() => {
    const scrollport = viewportRef.current;
    const content = contentRef.current;
    if (!scrollport || !content || !onAnchorChange) return;
    const viewportTop = scrollport.getBoundingClientRect().top;
    const rows = content.children;
    const count = rows.length - (content.lastElementChild?.hasAttribute('data-message-scroller-spacer') ? 1 : 0);
    // Measure only the containment boundaries. Reading an offscreen message's
    // descendants forces the browser to lay out content-visibility:auto rows.
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].getBoundingClientRect().bottom <= viewportTop) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < count; index += 1) {
      const row = rows[index];
      const nodeKey = row.querySelector<HTMLElement>('[data-ai-node-key]')?.dataset.aiNodeKey;
      if (!nodeKey) continue;
      const rect = row.getBoundingClientRect();
      onAnchorChange({ nodeKey, offset: rect.top - viewportTop, scrollTop: scrollport.scrollTop });
      break;
    }
  }, [onAnchorChange]);

  useLayoutEffect(() => {
    const scrollport = viewportRef.current;
    const content = contentRef.current;
    if (!initialAnchor || restoredAnchorRef.current || !scrollport || !content) return;
    const nodes = content.querySelectorAll<HTMLElement>('[data-ai-node-key]');
    if (!nodes.length) return;
    const node = [...nodes].find((candidate) => candidate.dataset.aiNodeKey === initialAnchor.nodeKey);
    const item = node?.closest<HTMLElement>('[data-slot="message-scroller-item"]');
    if (item?.dataset.messageId) {
      const messageId = item.dataset.messageId;
      const paddingTop = Number.parseFloat(getComputedStyle(content).paddingBlockStart) || 0;
      const options = { align: 'start' as const, scrollMargin: initialAnchor.offset - paddingTop };
      scrollToMessage(messageId, options);
      // Reopening reveals rows whose heights were estimated by content-visibility.
      // Let them lay out before aligning the saved offset a final time.
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = requestAnimationFrame(() => {
          restoreFrameRef.current = null;
          scrollToMessage(messageId, options);
        });
      });
    } else {
      scrollToStart();
      scrollport.scrollTop = initialAnchor.scrollTop;
    }
    // Saved positions are restored once on mount. Prepending and streaming
    // remain owned by MessageScroller, without replaying saved scroll events.
    restoredAnchorRef.current = true;
  }, [children, initialAnchor, scrollToMessage, scrollToStart]);

  return (
    <MessageScrollerPrimitive
      className={className}
      data-follow-key={followKey}
      role="log"
      aria-label={ariaLabel}
      onPointerDownCapture={handlePointerDown}
    >
      <MessageScrollerViewport
        ref={viewportRef}
        onScroll={readAnchor}
        onWheel={cancelRestore}
        onTouchMove={cancelRestore}
        onKeyDown={cancelRestore}
      >
        <MessageScrollerContent ref={contentRef} className={cn('gap-4 px-3 py-4', contentClassName)}>
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
  children?: React.ReactNode;
  reveal?: 'hover' | 'always';
}> = ({ text, align, timestamp, className, children, reveal = 'hover' }) => {
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
      data-actions-reveal={reveal}
    >
      {align === 'end' && time && <time dateTime={timestamp}>{time}</time>}
      {text && <Tooltip>
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
      </Tooltip>}
      {children}
      {align === 'start' && time && <time dateTime={timestamp}>{time}</time>}
      <span className="sr-only" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </div>
  );
};
