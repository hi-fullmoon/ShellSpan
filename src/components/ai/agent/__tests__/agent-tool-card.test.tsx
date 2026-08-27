import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeCompletedToolCall } from '@/test/agent-fixtures';
import type { AgentToolCallStateV1 } from '@/types/agent';
import { AgentToolCard } from '../agent-tool-card';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('AgentToolCard', () => {
  it('has an explicit visual state for every versioned tool state', () => {
    const states: AgentToolCallStateV1[] = [
      'proposed',
      'validating',
      'executing',
      'completed',
      'failed',
      'timedOut',
      'cancelled',
      'denied',
    ];
    const completed = makeCompletedToolCall();
    const { container } = render(
      <div>
        {states.map((state) => (
          <AgentToolCard
            key={state}
            toolCall={{
              ...completed,
              toolCallId: `tool-${state}`,
              state,
              result: state === 'completed' ? completed.result : undefined,
              evidenceIds: [],
            }}
            onEvidenceNavigate={vi.fn()}
          />
        ))}
      </div>,
    );

    for (const state of states) {
      expect(container.querySelector(`[data-tool-state="${state}"]`)).toBeInTheDocument();
    }
  });
});
