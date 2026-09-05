import type { ReactNode, RefObject } from 'react';
import { Popover, PopoverContent } from '@/components/ui/popover';

/** Both completions share placement while keyboard focus stays in the editor. */
export function AiCompletionPopover({ anchor, children, onDismiss }: {
  anchor: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  onDismiss(): void;
}) {
  if (!children) return null;
  return (
    <Popover open onOpenChange={(open, details) => {
      if (open) return;
      // Clicking within the composer can move the caret to another token.
      if (details.event.target instanceof Node && anchor.current?.contains(details.event.target)) {
        details.cancel();
        return;
      }
      onDismiss();
    }}>
      <PopoverContent
        anchor={anchor}
        collisionBoundary={anchor.current?.closest('[data-slot="ai-workspace-body"]') ?? undefined}
        collisionPadding={8}
        positionMethod="fixed"
        side="top"
        sideOffset={7}
        align="start"
        initialFocus={false}
        finalFocus={false}
        role="presentation"
        className="ai-completion-popup p-0 data-open:animate-none data-closed:animate-none"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
