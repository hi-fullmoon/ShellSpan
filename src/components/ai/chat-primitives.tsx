import React, { useLayoutEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export const MessageScroller: React.FC<{
  children: React.ReactNode;
  followKey: string;
  className?: string;
}> = ({ children, followKey, className }) => {
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [followKey]);

  return (
    <ScrollArea viewportRef={viewportRef} className={cn('min-h-0', className)} size="thin">
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </ScrollArea>
  );
};

export const Message: React.FC<{
  role: 'user' | 'assistant';
  children: React.ReactNode;
}> = ({ role, children }) => (
  <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
    {children}
  </div>
);

export const Bubble: React.FC<{
  role: 'user' | 'assistant';
  children: React.ReactNode;
}> = ({ role, children }) => (
  <div
    className={cn(
      'max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs leading-5',
      role === 'user'
        ? 'bg-primary text-primary-foreground'
        : 'border border-border bg-card text-card-foreground',
    )}
  >
    {children}
  </div>
);

export const Marker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-center text-[11px] text-muted-foreground">{children}</div>
);
