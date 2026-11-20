import { createContext } from 'react';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AiSubagentLineage } from '@/lib/ai/subagent-lineage';

export interface AiSubagentContextValue {
  readonly lineage: AiSubagentLineage | null;
  readonly toolChildSessionIds: ReadonlyMap<string, string>;
  readonly onOpenSession?: (summary: AiSessionSummary) => void;
}

export const AiSubagentContext = createContext<AiSubagentContextValue | null>(null);
