import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

export function AiUserMessageText({ text }: { readonly text: string }): React.ReactNode {
  const { t } = useI18n();
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setOverflow(element.scrollHeight > lineHeight * 3 + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    return () => { disposed = true; observer.disconnect(); };
  }, [text]);

  return (
    <div className="min-w-0">
      <span ref={ref} id={id} className={cn('ai-user-message-text block', !expanded && 'line-clamp-3')}>
        {text}
      </span>
      {overflow && (
        <Button variant="plain" size="xs" className="mt-1 p-0 hover:text-primary" aria-expanded={expanded} aria-controls={id}
          onClick={() => setExpanded(value => !value)}>
          {t(expanded ? 'ai.workspace.userMessage.collapse' : 'ai.workspace.userMessage.expand')}
        </Button>
      )}
    </div>
  );
}
