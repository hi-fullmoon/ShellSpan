import { create } from 'zustand';
import { parseDiagnosticAgentPlan } from '@/lib/diagnostic-agent';
import { generateId } from '@/lib/utils';
import type { AgentRun } from '@/types/ai';

interface AgentState {
  run?: AgentRun;
  beginRun: (requestId: string, goal: string, sessionId: string, contextLabel: string) => boolean;
  appendDelta: (requestId: string, text: string) => void;
  completePlanning: (requestId: string) => void;
  cancelRun: (requestId: string) => void;
  failRun: (requestId: string, error: string) => void;
  approveStep: (stepId: string, outputBaseline: string, executionMarker: string) => boolean;
  beginEvaluation: (
    stepId: string,
    requestId: string,
    result: string | undefined,
    exitCode: number,
  ) => boolean;
  rejectStep: (stepId: string) => void;
  stopRun: () => void;
  clear: () => void;
}

const ACTIVE_PHASES: AgentRun['phase'][] = [
  'planning',
  'awaitingApproval',
  'awaitingExecution',
  'evaluating',
];
const MAX_AGENT_COMMANDS = 8;

function advanceRun(run: AgentRun): AgentRun {
  if (run.steps.some((step) => step.status === 'inserted')) {
    return { ...run, phase: 'awaitingExecution' };
  }
  if (run.steps.some((step) => step.status === 'awaitingApproval')) {
    return { ...run, phase: 'awaitingApproval' };
  }
  let steps = run.steps;
  while (true) {
    const nextStep = steps.find((step) => step.status === 'queued');
    if (!nextStep) return { ...run, steps, phase: 'completed' };
    if (nextStep.kind === 'command') {
      return {
        ...run,
        phase: 'awaitingApproval',
        steps: steps.map((step) => (
          step.id === nextStep.id ? { ...step, status: 'awaitingApproval' as const } : step
        )),
      };
    }
    steps = steps.map((step) => (
      step.id === nextStep.id ? { ...step, status: 'completed' as const } : step
    ));
  }
}

export const useAgentStore = create<AgentState>()((set) => ({
  beginRun: (requestId, goal, sessionId, contextLabel) => {
    let started = false;
    set((state) => {
      if (state.run && ACTIVE_PHASES.includes(state.run.phase)) return state;
      started = true;
      return {
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
      };
    });
    return started;
  },
  appendDelta: (requestId, text) =>
    set((state) =>
      state.run?.requestId === requestId
      && ['planning', 'evaluating'].includes(state.run.phase)
        ? { run: { ...state.run, responseText: state.run.responseText + text } }
        : state,
    ),
  completePlanning: (requestId) =>
    set((state) => {
      if (
        !state.run
        || state.run.requestId !== requestId
        || !['planning', 'evaluating'].includes(state.run.phase)
      ) return state;
      try {
        const plan = parseDiagnosticAgentPlan(state.run.responseText);
        const commandBudgetExhausted = state.run.steps.filter((step) => (
          step.kind === 'command' && step.status === 'completed'
        )).length >= MAX_AGENT_COMMANDS;
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
              status: step.command
                ? commandBudgetExhausted
                  ? 'rejected' as const
                  : 'queued' as const
                : 'informational' as const,
            })),
          ],
        };
        return { run: advanceRun(run) };
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
  approveStep: (stepId, outputBaseline, executionMarker) => {
    let approved = false;
    set((state) => {
      if (!state.run) return state;
      const currentStep = state.run.steps.find((step) => step.id === stepId);
      if (currentStep?.status !== 'awaitingApproval') return state;
      approved = true;
      const run = {
        ...state.run,
        steps: state.run.steps.map((step) =>
          step.id === stepId
            ? { ...step, status: 'inserted' as const, outputBaseline, executionMarker }
            : step,
        ),
      };
      return { run: advanceRun(run) };
    });
    return approved;
  },
  beginEvaluation: (stepId, requestId, result, exitCode) => {
    let started = false;
    set((state) => {
      if (!state.run) return state;
      const currentStep = state.run.steps.find((step) => step.id === stepId);
      if (currentStep?.status !== 'inserted') return state;
      started = true;
      return {
        run: {
          ...state.run,
          requestId,
          phase: 'evaluating',
          responseText: '',
          error: undefined,
          steps: [
            ...state.run.steps.map((step) => {
              if (step.id === stepId) {
                return {
                  ...step,
                  status: 'completed' as const,
                  exitCode,
                  result: result?.trim().slice(0, 8000) || undefined,
                };
              }
              return step.status === 'queued'
                ? { ...step, status: 'superseded' as const }
                : step;
            }),
            {
              id: `analysis-${requestId}`,
              kind: 'analysis',
              title: 'diagnosticAgent.evaluate',
              description: '',
              status: 'running',
            },
          ],
        },
      };
    });
    return started;
  },
  rejectStep: (stepId) =>
    set((state) => {
      if (!state.run) return state;
      const run = {
        ...state.run,
        steps: state.run.steps.map((step) =>
          step.id === stepId && ['awaitingApproval', 'inserted'].includes(step.status)
            ? { ...step, status: 'rejected' as const }
            : step,
        ),
      };
      return { run: advanceRun(run) };
    }),
  stopRun: () =>
    set((state) => {
      if (!state.run || !ACTIVE_PHASES.includes(state.run.phase)) return state;
      return {
        run: {
          ...state.run,
          phase: 'cancelled',
          steps: state.run.steps.map((step) => {
            if (step.status === 'running') return { ...step, status: 'failed' as const };
            if (['queued', 'awaitingApproval', 'inserted'].includes(step.status)) {
              return { ...step, status: 'rejected' as const };
            }
            return step;
          }),
        },
      };
    }),
  clear: () => set({ run: undefined }),
}));
