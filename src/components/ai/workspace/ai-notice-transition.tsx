import { useEffect, useState } from 'react';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';

/** Animate notices in and preserve departing content until its exit completes. */
export function AiNoticeTransition({ children }: {
  readonly children: React.ReactElement | null;
}): React.ReactNode {
  const [lastContent, setLastContent] = useState(children);
  // Mount closed so Base UI measures and animates even an initially present notice.
  const [ready, setReady] = useState(false);
  const present = children !== null;
  useEffect(() => { setReady(present); }, [present]);
  if (children && children !== lastContent) setLastContent(children);
  if (!children && !lastContent) return null;

  return (
    <Collapsible open={ready && children !== null} className="contents">
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
