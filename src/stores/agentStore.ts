import { create } from 'zustand';
import { parseDiagnosticAgentPlan } from '@/lib/diagnostic-agent';
import { generateId } from '@/lib/utils';
import type { AgentRun } from '@/types/ai';

interface AgentState {
  run?: AgentRun;
  beginRun: (requestId: string, goal: string, sessionId: string, contextLabel: string) => void;
  appendDelta: (requestId: string, text: string) => void;
  completePlanning: (requestId: string) => void;
  cancelRun: (requestId: string) => void;
  failRun: (requestId: string, error: string) => void;
  approveStep: (stepId: string) => void;
  rejectStep: (stepId: string) => void;
  clear: () => void;
}

function resolveRunPhase(run: AgentRun): AgentRun['phase'] {
  return run.steps.some((step) => step.status === 'awaitingApproval')
    ? 'awaitingApproval'
    : 'completed';
}

export const useAgentStore = create<AgentState>()((set) => ({
  beginRun: (requestId, goal, sessionId, contextLabel) =>
    set({
      run: {
        id: generateId(),
        requestId,
        goal,
        sessionId,
        contextLabel,
        phase: 'planning',
        responseText: '',
        steps: [
          {
            id: generateId(),
            kind: 'tool',
            title: 'terminal.getContext',
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
    }),
  appendDelta: (requestId, text) =>
    set((state) =>
      state.run?.requestId === requestId
        ? { run: { ...state.run, responseText: state.run.responseText + text } }
        : state,
    ),
  completePlanning: (requestId) =>
    set((state) => {
      if (!state.run || state.run.requestId !== requestId) return state;
      try {
        const plan = parseDiagnosticAgentPlan(state.run.responseText);
        const run: AgentRun = {
          ...state.run,
          summary: plan.summary,
          steps: [
            ...state.run.steps.map((step) =>
              step.id === `analysis-${requestId}`
                ? { ...step, status: 'completed' as const, description: plan.summary }
                : step,
            ),
            ...plan.steps.map((step) => ({
              ...step,
              id: generateId(),
              kind: step.command ? 'command' as const : 'analysis' as const,
              status: step.command ? 'awaitingApproval' as const : 'completed' as const,
            })),
          ],
        };
        return { run: { ...run, phase: resolveRunPhase(run) } };
      } catch (reason) {
        return {
          run: {
            ...state.run,
            phase: 'error',
            error: reason instanceof Error ? reason.message : String(reason),
            steps: state.run.steps.map((step) =>
              step.id === `analysis-${requestId}` ? { ...step, status: 'failed' as const } : step,
            ),
          },
        };
      }
    }),
  cancelRun: (requestId) =>
    set((state) =>
      state.run?.requestId === requestId
        ? {
            run: {
              ...state.run,
              phase: 'cancelled',
              steps: state.run.steps.map((step) =>
                step.status === 'running' ? { ...step, status: 'failed' as const } : step,
              ),
            },
          }
        : state,
    ),
  failRun: (requestId, error) =>
    set((state) =>
      state.run?.requestId === requestId
        ? {
            run: {
              ...state.run,
              phase: 'error',
              error,
              steps: state.run.steps.map((step) =>
                step.status === 'running' ? { ...step, status: 'failed' as const } : step,
              ),
            },
          }
        : state,
    ),
  approveStep: (stepId) =>
    set((state) => {
      if (!state.run) return state;
      const run = {
        ...state.run,
        steps: state.run.steps.map((step) =>
          step.id === stepId && step.status === 'awaitingApproval'
            ? { ...step, status: 'approved' as const }
            : step,
        ),
      };
      return { run: { ...run, phase: resolveRunPhase(run) } };
    }),
  rejectStep: (stepId) =>
    set((state) => {
      if (!state.run) return state;
      const run = {
        ...state.run,
        steps: state.run.steps.map((step) =>
          step.id === stepId && step.status === 'awaitingApproval'
            ? { ...step, status: 'rejected' as const }
            : step,
        ),
      };
      return { run: { ...run, phase: resolveRunPhase(run) } };
    }),
  clear: () => set({ run: undefined }),
}));
