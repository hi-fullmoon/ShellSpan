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
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageLayoutContext } from './message-layout-context';
import { useTurnScrollTransition } from './workspace/use-turn-scroll-transition';

interface MessageScrollerProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  followKey: string;
  turnAnchorKey?: string;
  /** New local submission/message identities resume following once per identity. */
  scrollToBottomKeys?: readonly string[];
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
  initialAnchor?: AiScrollAnchor;
  onAnchorChange?: (anchor: AiScrollAnchor) => void;
  onFollowLatest?: () => void;
}

interface ConversationScrollerProps extends MessageScrollerProps {
  restoreToEnd?: boolean;
}

const SCROLL_EDGE_THRESHOLD = 8;

/** Remaining distance to the bottom edge; negative while rubber-band overscroll stretches past it. */
function distanceToBottom(viewport: HTMLElement): number {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

function isNearBottom(viewport: HTMLElement): boolean {
  return distanceToBottom(viewport) <= SCROLL_EDGE_THRESHOLD;
}

function wantsScrollAnchor(child: React.ReactNode): boolean {
  return React.isValidElement<{ role?: string; scrollAnchor?: boolean }>(child)
    && (child.props.scrollAnchor ?? child.props.role === 'user');
}

function messageItemId(child: React.ReactNode, index: number): string {
  if (!React.isValidElement<{ scrollItemId?: string }>(child)) return String(index);
  return child.props.scrollItemId
    ?? (child.key === null ? String(index) : String(child.key));
}

function messageItemClassName(child: React.ReactNode): string | undefined {
  return React.isValidElement<{ scrollItemClassName?: string }>(child)
    ? child.props.scrollItemClassName
    : undefined;
}

export const MessageScroller: React.FC<MessageScrollerProps> = (props) => {
  const openingAnchor = useRef(props.initialAnchor);
  const restoreToEnd = openingAnchor.current?.atBottom === true;
  // Following the latest output is navigation state too. Restoring it through
  // scrollToMessage would leave the primitive in its detached jump mode.
  const readingAnchor = restoreToEnd ? undefined : openingAnchor.current;
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition={readingAnchor ? 'start' : props.turnAnchorKey && !restoreToEnd ? 'last-anchor' : 'end'}
      scrollEdgeThreshold={SCROLL_EDGE_THRESHOLD}
      scrollPreviousItemPeek={0}
    >
      <ConversationScroller {...props} initialAnchor={readingAnchor} restoreToEnd={restoreToEnd} />
    </MessageScrollerProvider>
  );
};

const ConversationScroller: React.FC<ConversationScrollerProps> = ({
  children,
  header,
  followKey,
  turnAnchorKey,
  scrollToBottomKeys,
  className,
  contentClassName,
  ariaLabel,
  initialAnchor,
  onAnchorChange,
  onFollowLatest,
  restoreToEnd = false,
}) => {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // A top-aligned turn can also sit at the scrollport's bottom. Its own scroll
  // event must not turn that reading position into live-tail follow mode.
  const suppressProgrammaticFollowRef = useRef(initialAnchor?.atBottom === false);
  const followIntentRef = useRef(initialAnchor?.atBottom !== false && !turnAnchorKey);
  const resumeFollowOnScrollRef = useRef(false);
  const pointerScrollStartRef = useRef<number | null>(null);
  const restoredAnchorRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);
  const [positionReady, setPositionReady] = useState(false);
  const { scrollToEnd, scrollToMessage, scrollToStart } = useMessageScroller();
  const observedBottomKeys = useRef(new Set(scrollToBottomKeys));
  const childItems = React.Children.toArray(children);
  const turnAnchor = [...childItems].reverse().find(wantsScrollAnchor);
  useTurnScrollTransition(viewportRef, turnAnchor ? messageItemId(turnAnchor, childItems.indexOf(turnAnchor)) : undefined);
  const observedAnchorItemsRef = useRef(new Set(childItems.filter(wantsScrollAnchor).map(messageItemId)));
  const messageItems = childItems.map((child, index) => {
    const itemKey = React.isValidElement(child) && child.key !== null ? child.key : index;
    const messageId = messageItemId(child, index);
    return (
      <MessageScrollerItem key={itemKey} messageId={messageId} scrollAnchor={wantsScrollAnchor(child)}
        // History is already paged by AiConversation. Estimate-free row layout
        // keeps the scroll range stable while wheel/scrollbar gestures expose
        // long Markdown rows, including after the panel width changes.
        className={cn(messageItemClassName(child), '[content-visibility:visible] [contain-intrinsic-size:none]')}>
        {child}
      </MessageScrollerItem>
    );
  });

  const cancelRestore = useCallback(() => {
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
  }, []);

  const interruptRestore = useCallback(() => {
    cancelRestore();
    setPositionReady(true);
  }, [cancelRestore]);

  useLayoutEffect(() => {
    let requested = false;
    for (const key of scrollToBottomKeys ?? []) {
      if (observedBottomKeys.current.has(key)) continue;
      observedBottomKeys.current.add(key);
      requested = true;
    }
    if (!requested) return;
    // Bound navigation memory while retaining recent optimistic/committed IDs
    // so acknowledgement cannot pull a user who has since scrolled up.
    while (observedBottomKeys.current.size > 256) {
      observedBottomKeys.current.delete(observedBottomKeys.current.values().next().value!);
    }
    cancelRestore();
    restoredAnchorRef.current = true;
    suppressProgrammaticFollowRef.current = false;
    followIntentRef.current = true;
    onFollowLatest?.();
    pointerScrollStartRef.current = null;
    scrollToEnd();
    // Resume the primitive's bottom-follow mode once. It observes subsequent
    // composer/content resizes; replaying the jump on later frames competes
    // with that adjustment and can override the user's next scroll gesture.
    setPositionReady(true);
  }, [cancelRestore, onFollowLatest, scrollToBottomKeys, scrollToEnd]);

  const handlePointerDown = useCallback(() => {
    interruptRestore();
    resumeFollowOnScrollRef.current = false;
    pointerScrollStartRef.current = viewportRef.current?.scrollTop ?? null;
  }, [interruptRestore]);

  useEffect(() => {
    const clearPointerIntent = () => { pointerScrollStartRef.current = null; };
    // Release may happen outside the transcript (including a native scrollbar).
    // A completed click must not turn a later layout correction into a drag.
    window.addEventListener('pointerup', clearPointerIntent, true);
    window.addEventListener('pointercancel', clearPointerIntent, true);
    window.addEventListener('blur', clearPointerIntent);
    return () => {
      window.removeEventListener('pointerup', clearPointerIntent, true);
      window.removeEventListener('pointercancel', clearPointerIntent, true);
      window.removeEventListener('blur', clearPointerIntent);
    };
  }, []);

  const handleScrollCapture = useCallback(() => {
    const viewport = viewportRef.current;
    // Keyboard scrolling happens after keydown's default action. Resume only
    // once that requested movement has actually reached the live edge.
    if (viewport && resumeFollowOnScrollRef.current && isNearBottom(viewport)) {
      followIntentRef.current = true;
      resumeFollowOnScrollRef.current = false;
    }
    const start = pointerScrollStartRef.current;
    if (!viewport || start === null || Math.abs(viewport.scrollTop - start) <= 0.5) return;
    pointerScrollStartRef.current = viewport.scrollTop;
    suppressProgrammaticFollowRef.current = false;
    if (viewport.scrollTop > start && isNearBottom(viewport)) {
      followIntentRef.current = true;
      // A prior upward drag enters the primitive's settling-jump mode. Native
      // scrollbar movement emits no wheel/key event to release that mode.
      // Skip only while rubber-band overscroll sits past the bottom edge, where
      // re-clamping would cancel the native bounce-back.
      if (distanceToBottom(viewport) >= 0) scrollToEnd();
    } else if (viewport.scrollTop < start && !isNearBottom(viewport)) {
      followIntentRef.current = false;
      // A scrollbar drag may overlap the primitive's programmatic-scroll grace
      // period. Its public jump API releases following without synthetic input.
      const top = viewport.getBoundingClientRect().top;
      const item = Array.from(contentRef.current?.children ?? []).find((row) => (
        row instanceof HTMLElement && row.dataset.messageId && row.getBoundingClientRect().bottom > top
      ));
      if (item instanceof HTMLElement && item.dataset.messageId) {
        const paddingTop = contentRef.current
          ? Number.parseFloat(getComputedStyle(contentRef.current).paddingBlockStart) || 0
          : 0;
        scrollToMessage(item.dataset.messageId, {
          align: 'start', scrollMargin: item.getBoundingClientRect().top - top - paddingTop,
        });
      }
    }
  }, [scrollToEnd, scrollToMessage]);

  const handleWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (event.deltaY < 0) {
      followIntentRef.current = false;
      resumeFollowOnScrollRef.current = false;
      return;
    }
    if (event.deltaY > 0) {
      suppressProgrammaticFollowRef.current = false;
      // The primitive marks the live edge as non-scrollable even while a
      // streamed resize is waiting for its frame. Preserve that follow intent.
      if (viewport && (isNearBottom(viewport) || !viewport.dataset.scrollable?.split(' ').includes('end'))) {
        followIntentRef.current = true;
        interruptRestore();
        // macOS rubber-band scrolling reports scrollTop past the bottom edge;
        // writing scrollTop on those wheel events cancels the native bounce.
        // Only jump while real distance remains (e.g. streamed output grew).
        if (distanceToBottom(viewport) > 0.5) {
          scrollToEnd();
        }
        event.stopPropagation();
      }
    }
  }, [interruptRestore, scrollToEnd]);

  useLayoutEffect(() => () => {
    cancelRestore();
    restoredAnchorRef.current = false;
  }, [cancelRestore]);

  const commitMessageLayout = useCallback(() => {
    // A throttled child can commit without changing children/followKey here.
    // Use the recorded user intent, not geometry after the text has grown.
    if (positionReady && followIntentRef.current && !suppressProgrammaticFollowRef.current) {
      scrollToEnd();
    }
  }, [positionReady, scrollToEnd]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    for (const [index, child] of childItems.entries()) {
      if (!wantsScrollAnchor(child)) continue;
      const id = messageItemId(child, index);
      if (!observedAnchorItemsRef.current.has(id)) followIntentRef.current = false;
      observedAnchorItemsRef.current.add(id);
    }
    if (!positionReady || !viewport || !followIntentRef.current || suppressProgrammaticFollowRef.current) return;
    // Markdown can gain a line or change block type during a stream. The
    // primitive corrects resized content on a later animation frame; align in
    // this commit so the old bottom is never painted between stream updates.
    if (!viewport.dataset.scrollable?.split(' ').includes('end')) scrollToEnd();
  }, [children, followKey, positionReady, scrollToEnd]);

  const readAnchor = useCallback(() => {
    const scrollport = viewportRef.current;
    if (!scrollport) return;
    const content = contentRef.current;
    if (!content || !onAnchorChange) return;
    const viewportTop = scrollport.getBoundingClientRect().top;
    const rows = content.children;
    const count = rows.length - (content.lastElementChild?.hasAttribute('data-message-scroller-spacer') ? 1 : 0);
    // Search row boundaries rather than measuring every message descendant.
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
      onAnchorChange({
        nodeKey, offset: rect.top - viewportTop, scrollTop: scrollport.scrollTop,
        atBottom: !suppressProgrammaticFollowRef.current && isNearBottom(scrollport),
      });
      break;
    }
  }, [onAnchorChange]);

  useLayoutEffect(() => {
    const scrollport = viewportRef.current;
    const content = contentRef.current;
    if (restoredAnchorRef.current || !scrollport || !content) return;
    const nodes = content.querySelectorAll<HTMLElement>('[data-ai-node-key]');
    if (initialAnchor && !nodes.length) return;
    const node = initialAnchor
      ? [...nodes].find((candidate) => candidate.dataset.aiNodeKey === initialAnchor.nodeKey)
      : undefined;
    const item = node?.closest<HTMLElement>('[data-slot="message-scroller-item"]');
    let restoreAnchor: () => void;
    if (!initialAnchor) {
      // Let the primitive own the anchored-to-message mode and transition to
      // following-bottom as the response fills the viewport. scrollToMessage
      // would instead enter its detached, permanent jump mode.
      restoreAnchor = turnAnchorKey && !restoreToEnd
        ? () => {}
        : () => { scrollToEnd(); };
    } else if (item?.dataset.messageId) {
      const messageId = item.dataset.messageId;
      const paddingTop = Number.parseFloat(getComputedStyle(content).paddingBlockStart) || 0;
      const options = { align: 'start' as const, scrollMargin: initialAnchor.offset - paddingTop };
      restoreAnchor = () => {
        scrollToMessage(messageId, options);
        // A jump can add a spacer to align a message beyond the natural end.
        // Restoring a shorter/reflowed transcript must clamp to its real end.
        const spacer = content.querySelector<HTMLElement>('[data-message-scroller-spacer]');
        // Legacy anchors without atBottom may still represent a live edge.
        // An explicit false preserves a top-aligned turn when it is reopened.
        if (initialAnchor.atBottom !== false && ((spacer && !spacer.hidden) || isNearBottom(scrollport))) {
          scrollToEnd();
        }
      };
    } else {
      restoreAnchor = () => {
        scrollToStart();
        scrollport.scrollTop = initialAnchor.scrollTop;
      };
    }
    restoreAnchor();
    // Reveal after the primitive's initial layout and scroll position settle.
    restoreFrameRef.current = requestAnimationFrame(() => {
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        restoreAnchor();
        setPositionReady(true);
      });
    });
    // Saved positions are restored once on mount. Prepending and streaming
    // remain owned by MessageScroller, without replaying saved scroll events.
    restoredAnchorRef.current = true;
  }, [children, initialAnchor, restoreToEnd, scrollToEnd, scrollToMessage, scrollToStart, turnAnchorKey]);

  return (
    <MessageScrollerPrimitive
      className={cn(className, !positionReady && 'invisible')}
      data-follow-key={followKey}
      role="log"
      aria-label={ariaLabel}
      onPointerDownCapture={handlePointerDown}
    >
      {header && <div className="shrink-0">{header}</div>}
      <MessageScrollerViewport
        ref={viewportRef}
        onScrollCapture={handleScrollCapture}
        onScroll={readAnchor}
        onWheelCapture={handleWheelCapture}
        onWheel={interruptRestore}
        onTouchMove={() => {
          followIntentRef.current = false;
          resumeFollowOnScrollRef.current = false;
          suppressProgrammaticFollowRef.current = false;
          interruptRestore();
        }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) {
            const viewport = viewportRef.current;
            if (['ArrowDown', 'End', 'PageDown', ' '].includes(event.key)) {
              if (event.key === ' ' && event.shiftKey) {
                followIntentRef.current = false;
                resumeFollowOnScrollRef.current = false;
                interruptRestore();
                return;
              }
              suppressProgrammaticFollowRef.current = false;
              resumeFollowOnScrollRef.current = true;
              if (viewport && isNearBottom(viewport)) {
                followIntentRef.current = true;
                resumeFollowOnScrollRef.current = false;
                scrollToEnd();
              }
            } else if (['ArrowUp', 'Home', 'PageUp'].includes(event.key)) {
              followIntentRef.current = false;
              resumeFollowOnScrollRef.current = false;
            }
          }
          interruptRestore();
        }}
      >
        <MessageScrollerContent ref={contentRef} className={cn('gap-4 px-3 py-4', contentClassName)}>
          <MessageLayoutContext.Provider value={commitMessageLayout}>
            {messageItems}
          </MessageLayoutContext.Provider>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <Tooltip>
        <TooltipTrigger render={<MessageScrollerButton
          aria-label={t('ai.scrollToLatest')}
          onClick={() => {
            suppressProgrammaticFollowRef.current = false;
            followIntentRef.current = true;
            onFollowLatest?.();
          }}
        />}>
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
      className={cn('ai-message flex w-full min-w-0 max-w-full', `ai-message-${role}`)}
      role="article"
      aria-label={role === 'user' ? t('ai.message.user') : t('ai.message.assistant')}
    >
      <MessageContent className={cn('ai-message-content min-w-0 max-w-full gap-1.5', role === 'user' && 'items-end')}>
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
        'ai-message-bubble min-w-0 max-w-full',
      `ai-message-bubble-${role}`,
      role === 'user'
        ? 'max-w-[82%]'
        : 'w-full max-w-full',
    )}
  >
    <BubbleContent
      className={cn(
        'ai-message-bubble-content min-w-0 max-w-full',
        role === 'user'
          ? 'max-w-full overflow-visible px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]'
          : 'block w-full overflow-visible p-0',
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
    <MarkerContent className={cn('ai-flow-marker min-w-0 [overflow-wrap:anywhere]', variant === 'default' && 'w-full')}>
      {children}
    </MarkerContent>
  </MarkerPrimitive>
);

export const MessageActions: React.FC<{
  text: string;
  align: 'start' | 'end';
  timestamp?: string;
  className?: string;
  actionClassName?: string;
  children?: React.ReactNode;
  reveal?: 'hover' | 'always';
}> = ({ text, align, timestamp, className, actionClassName, children, reveal = 'hover' }) => {
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
      className={cn(
        'ai-message-actions isolate flex h-7 items-center gap-2',
        align === 'end' && 'justify-end',
        className,
      )}
      data-align={align}
      data-actions-reveal={reveal}
    >
      {align === 'end' && time && <time className="whitespace-nowrap px-0.5" dateTime={timestamp}>{time}</time>}
      {text && <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn('ai-message-action grid size-7 place-items-center p-0', actionClassName)}
              aria-label={copied ? t('common.copied') : t('common.copy')}
              onClick={copy}
            />
          )}
        >
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        </TooltipTrigger>
        <TooltipContent>{copied ? t('common.copied') : t('common.copy')}</TooltipContent>
      </Tooltip>}
      {children}
      {align === 'start' && time && <time className="whitespace-nowrap px-0.5" dateTime={timestamp}>{time}</time>}
      <span className="sr-only" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </div>
  );
};
