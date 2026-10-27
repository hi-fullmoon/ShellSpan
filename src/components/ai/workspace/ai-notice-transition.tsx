import { useState } from 'react';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';

/** Preserve a departing notice until Base UI finishes its exit transition. */
export function AiNoticeTransition({ children }: {
  readonly children: React.ReactElement | null;
}): React.ReactNode {
  const [lastContent, setLastContent] = useState(children);
  if (children && children !== lastContent) setLastContent(children);
  if (!children && !lastContent) return null;

  return (
    <Collapsible open={children !== null} className="contents">
      <CollapsibleContent
        data-slot="ai-notice-transition"
        className="ai-notice-transition"
        inert={!children || undefined}
        aria-hidden={!children || undefined}
      >
        {children ?? lastContent}
      </CollapsibleContent>
    </Collapsible>
  );
}
