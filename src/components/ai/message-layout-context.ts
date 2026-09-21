import { createContext, useContext, useLayoutEffect } from 'react';

/** Locally scheduled message commits still participate in the scroller's layout. */
export const MessageLayoutContext = createContext<(() => void) | null>(null);

export function useMessageLayoutCommit(revision: number): void {
  const commit = useContext(MessageLayoutContext);
  useLayoutEffect(() => { commit?.(); }, [commit, revision]);
}
