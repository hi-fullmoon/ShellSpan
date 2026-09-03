import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { createAiComposerState, type AiComposerState } from '@/lib/ai/composer-machine';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

function Harness({
  initial,
  onSubmitGesture = vi.fn(),
  onStop = vi.fn(),
  onRetry = vi.fn(),
}: {
  initial: AiComposerState;
  onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  onStop?: () => void;
  onRetry?: (id: string) => void;
}): React.ReactNode {
  const [state, setState] = useState(initial);
  return (
    <div className="@container/ai-workspace">
      <AiComposerSeat
        phase="active"
        sessionKind={state.preset}
        status={state.runtimeStatus}
        composerState={state}
        inbox={[
          { id: 'queue-1', lane: 'nextTurn', content: 'Run tests next', state: 'queued', source: 'user' },
          { id: 'steer-1', lane: 'nextStep', content: 'Do not restart', state: 'claimed', source: 'runtime' },
        ]}
        onDraftChange={(draft) => setState((current) => ({ ...current, draft }))}
        onSubmitGesture={onSubmitGesture}
        onStop={onStop}
        onRetryFailedDraft={onRetry}
        onDismissError={() => setState((current) => ({ ...current, lastError: null }))}
      />
    </div>
  );
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => cleanup());

describe('AiComposerSeat Phase 4 behavior', () => {
  it('maps Enter and Ctrl/Cmd+Enter while preserving Shift+Enter and IME composition', () => {
    const submit = vi.fn();
    render(<Harness initial={createAiComposerState({ draft: 'Queue me' })} onSubmitGesture={submit} />);
    const textbox = screen.getByRole('textbox');

    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textbox, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(textbox, { key: 'Enter', repeat: true });
    expect(submit).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: 'Enter' });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });
    expect(submit.mock.calls).toEqual([
      ['keyboard', false],
      ['keyboard', true],
      ['keyboard', true],
    ]);
  });

  it('uses an unambiguous Stop button for an empty running Composer', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    render(<Harness initial={createAiComposerState({
      phase: 'running', runtimeStatus: 'running', preset: 'agent', presetLocked: true,
      sessionId: 'session-1', draft: '',
    })} onStop={stop} />);

    await user.click(screen.getByRole('button', { name: 'Stop task' }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Queue for next turn' })).toBeNull();
  });

  it('keeps approval drafts visible but disabled without implementing takeover actions', () => {
    render(<Harness initial={createAiComposerState({
      phase: 'waitingApproval', runtimeStatus: 'waiting', waitingApproval: true,
      preset: 'agent', presetLocked: true, sessionId: 'session-1', draft: 'keep this draft',
    })} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('keep this draft');
    expect(screen.getByText('Waiting for approval')).toBeVisible();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('renders Runtime Inbox with lane, state, and Phase 6 mutation controls', () => {
    render(<Harness initial={createAiComposerState()} />);
    expect(screen.getByRole('region', { name: 'Queued input' })).toBeVisible();
    expect(screen.getByText('Run tests next')).toBeVisible();
    expect(screen.getByText('Next turn')).toBeVisible();
    expect(screen.getByText('Claimed')).toBeVisible();
    expect(screen.getAllByRole('button', { name: /edit|remove/i })).toHaveLength(2);
  });

  it('shows a retry entry without replacing the current draft', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const error = { kind: 'offline' as const, message: 'Provider disconnected', retryable: true };
    render(<Harness initial={createAiComposerState({
      phase: 'error', draft: 'new input', lastError: error,
      failedDrafts: [{ id: 'failed-1', content: 'failed input', mode: 'nextTurn', error }],
    })} onRetry={retry} />);
    expect(screen.getByRole('textbox')).toHaveValue('new input');
    expect(screen.getByText('failed input')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith('failed-1');
    expect(screen.getByRole('textbox')).toHaveValue('new input');
  });
});
