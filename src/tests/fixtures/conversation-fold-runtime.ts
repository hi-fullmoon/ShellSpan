import capture from './conversation-fold-runtime.json';
import type { AgentSessionEvent } from '@/types/agent-session';

// Extracted from local real-model Session v5 logs. Only presentation events
// are retained; replay envelopes and reasoning are omitted. Event order,
// message text, tools, IDs, timestamps and end reasons are unchanged. Replay
// offsets are contiguous; sourceSeqs records each original durable offset.
export const conversationFoldRecording = capture as unknown as Readonly<Record<
  'direct' | 'progress' | 'continued' | 'completed',
  { readonly sourceFile: string; readonly sourceSeqs: readonly number[]; readonly events: readonly AgentSessionEvent[] }
>>;
