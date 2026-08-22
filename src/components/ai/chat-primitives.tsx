import React from 'react';
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

export const MessageScroller: React.FC<{
  children: React.ReactNode;
  followKey: string;
  className?: string;
  ariaLabel?: string;
}> = ({ children, followKey, className, ariaLabel }) => {
  const { t } = useI18n();
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScrollerPrimitive
        className={className}
        data-follow-key={followKey}
        role="log"
        aria-label={ariaLabel}
      >
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-5 px-4 py-5">
            {React.Children.map(children, (child, index) => (
              <MessageScrollerItem
                key={React.isValidElement(child) && child.key !== null ? child.key : index}
                scrollAnchor={
                  React.isValidElement<{ role?: string }>(child) && child.props.role === 'user'
                }
              >
                {child}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton>
          <ArrowDownIcon />
          <span className="sr-only">{t('ai.scrollToLatest')}</span>
        </MessageScrollerButton>
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
    className={cn(role === 'user' ? 'max-w-[86%]' : 'w-full max-w-full')}
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

export const Marker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MarkerPrimitive>
    <MarkerContent className="w-full text-center">{children}</MarkerContent>
  </MarkerPrimitive>
);
