import { useEffect, useState } from 'react';
import { childBudgetExhausted, childContinuationDeadline } from '@/lib/ai/subagent-continuation';
import type { AgentSessionSnapshot } from '@/types/agent-session';

/** Idle children can exhaust their wall-clock allowance without publishing an event. */
export function useSubagentBudget(snapshot: AgentSessionSnapshot | null | undefined, now = Date.now): boolean {
  const [, refresh] = useState(0);
  const deadline = childContinuationDeadline(snapshot);
  useEffect(() => {
    if (deadline === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      clearTimeout(timer);
      refresh(value => value + 1);
      const remaining = deadline - now();
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    const foreground = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    const remaining = deadline - now();
    if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [deadline, now]);
  return childBudgetExhausted(snapshot, now());
}
