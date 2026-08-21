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

export const MessageScroller: React.FC<{
  children: React.ReactNode;
  followKey: string;
  className?: string;
}> = ({ children, followKey, className }) => {
  const { t } = useI18n();
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScrollerPrimitive className={className} data-follow-key={followKey}>
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-3 p-3">
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
}> = ({ role, children }) => (
  <MessagePrimitive align={role === 'user' ? 'end' : 'start'}>
    <MessageContent>{children}</MessageContent>
  </MessagePrimitive>
);

export const Bubble: React.FC<{
  role: 'user' | 'assistant';
  children: React.ReactNode;
}> = ({ role, children }) => (
  <BubblePrimitive
    align={role === 'user' ? 'end' : 'start'}
    variant={role === 'user' ? 'default' : 'outline'}
    className="max-w-[92%]"
  >
    <BubbleContent className="whitespace-pre-wrap text-xs leading-5">
      {children}
    </BubbleContent>
  </BubblePrimitive>
);

export const Marker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MarkerPrimitive>
    <MarkerContent className="w-full text-center">{children}</MarkerContent>
  </MarkerPrimitive>
);
