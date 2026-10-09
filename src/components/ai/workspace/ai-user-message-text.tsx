import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageReadingContext } from '@/components/ai/message-layout-context';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

const PREVIEW_LINES = 6;

export function AiUserMessageText({ text }: { readonly text: string }) {
  const { t } = useI18n();
  const preserveReadingPosition = useContext(MessageReadingContext);
  const id = useId();
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflowing(element.scrollHeight > lineHeight * PREVIEW_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <>
      <span
        ref={textRef}
        id={id}
        className={cn('ai-user-message-text', expanded ? 'block' : 'line-clamp-6')}
        data-collapsed={!expanded || undefined}
      >
        {text}
      </span>
      {overflowing && (
        <Button
          variant="link"
          size="xs"
          className="ai-user-message-toggle mt-1 px-0"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            preserveReadingPosition?.();
            setExpanded((value) => !value);
          }}
        >
          {t(expanded ? 'ai.workspace.messageCollapse' : 'ai.workspace.messageExpand')}
        </Button>
      )}
    </>
  );
}
