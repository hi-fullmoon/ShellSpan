import { create } from 'zustand';
import { parseDiagnosticAgentPlan } from '@/lib/diagnostic-agent';
import { generateId } from '@/lib/utils';
import type { AgentRun } from '@/types/ai';

interface AgentState {
  run?: AgentRun;
  beginRun: (
    requestId: string,
    goal: string,
    sessionId: string,
    contextLabel: string,
    profileId?: string,
    contextSource?: 'terminal' | 'remoteHealth',
    contextObservedAt?: number,
    conversationId?: string,
  ) => boolean;
  appendDelta: (requestId: string, text: string) => void;
  completePlanning: (requestId: string) => void;
  cancelRun: (requestId: string) => void;
  failRun: (requestId: string, error: string) => void;
  markHandedOff: () => void;
  stopRun: () => void;
  clear: () => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  beginRun: (
    requestId,
    goal,
    sessionId,
    contextLabel,
    profileId,
    contextSource = 'terminal',
    contextObservedAt = Date.now(),
    conversationId,
  ) => {
    let started = false;
    set((state) => {
      if (state.run?.phase === 'planning') return state;
      started = true;
      return {
        run: {
          id: generateId(),
          requestId,
          goal,
          sessionId,
          conversationId,
          profileId,
          contextLabel,
          contextSource,
          contextObservedAt,
          phase: 'planning',
          responseText: '',
          steps: [
            {
              id: generateId(),
              kind: 'tool',
              title: contextSource === 'remoteHealth'
                ? 'remoteHealth.getSnapshotContext'
                : 'terminal.getContext',
              description: contextLabel,
              status: 'completed',
            },
            {
              id: `analysis-${requestId}`,
              kind: 'analysis',
              title: 'diagnosticAgent.plan',
              description: '',
              status: 'running',
            },
          ],
        },
      };
    });
    return started;
  },
  appendDelta: (requestId, text) =>
    set((state) => state.run?.requestId === requestId && state.run.phase === 'planning'
      ? { run: { ...state.run, responseText: state.run.responseText + text } }
      : state),
  completePlanning: (requestId) =>
    set((state) => {
      if (!state.run || state.run.requestId !== requestId || state.run.phase !== 'planning') {
        return state;
      }
      try {
        const plan = parseDiagnosticAgentPlan(state.run.responseText);
        return {
          run: {
            ...state.run,
            phase: 'awaitingReview',
            summary: plan.summary,
            plan,
            steps: [
              ...state.run.steps.map((step) => step.id === `analysis-${requestId}`
                ? { ...step, status: 'completed' as const, description: plan.summary }
                : step),
              ...plan.steps.map((step) => ({
                ...step,
                kind: 'command' as const,
                status: 'informational' as const,
              })),
            ],
          },
        };
      } catch (reason) {
        return {
          run: {
            ...state.run,
            phase: 'error',
            error: reason instanceof Error ? reason.message : String(reason),
            steps: state.run.steps.map((step) => step.id === `analysis-${requestId}`
              ? { ...step, status: 'failed' as const }
              : step),
          },
        };
      }
    }),
  cancelRun: (requestId) =>
    set((state) => state.run?.requestId === requestId && state.run.phase === 'planning'
      ? {
          run: {
            ...state.run,
            phase: 'cancelled',
            steps: state.run.steps.map((step) => step.status === 'running'
              ? { ...step, status: 'failed' as const }
              : step),
          },
        }
      : state),
  failRun: (requestId, error) =>
    set((state) => state.run?.requestId === requestId
      ? {
          run: {
            ...state.run,
            phase: 'error',
            error,
            steps: state.run.steps.map((step) => step.status === 'running'
              ? { ...step, status: 'failed' as const }
              : step),
          },
        }
      : state),
  markHandedOff: () => set((state) => state.run?.phase === 'awaitingReview'
    ? { run: { ...state.run, phase: 'handedOff' } }
    : state),
  stopRun: () =>
    set((state) => state.run?.phase === 'planning'
      ? {
          run: {
            ...state.run,
            phase: 'cancelled',
            steps: state.run.steps.map((step) => step.status === 'running'
              ? { ...step, status: 'failed' as const }
              : step),
          },
        }
      : state),
  clear: () => set({ run: undefined }),
}));
