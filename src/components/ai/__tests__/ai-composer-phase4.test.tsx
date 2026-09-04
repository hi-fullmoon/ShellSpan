import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { AiComposerModelSelector } from '@/components/ai/workspace/ai-composer-model-selector';
import { createAiComposerState, type AiComposerState } from '@/lib/ai/composer-machine';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';

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
  it('adds pasted images once without submitting the message', () => {
    const onPasteImages = vi.fn();
    const onSubmit = vi.fn();
    render(<AiComposerSeat phase="active" status="idle" defaultDraft="Describe this" onPasteImages={onPasteImages} onSubmit={onSubmit} />);
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const document = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const accepted = fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        files: [image, document],
        items: [{ kind: 'file', type: image.type, getAsFile: () => image }],
      },
    });
    expect(accepted).toBe(false);
    expect(onPasteImages.mock.calls).toEqual([[[image]]]);
    expect(screen.getByRole('textbox')).toHaveValue('Describe this');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts clipboard image items when the browser has no file list', () => {
    const onPasteImages = vi.fn();
    render(<AiComposerSeat phase="hero" status="idle" onPasteImages={onPasteImages} />);
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [], items: [{ kind: 'file', type: image.type, getAsFile: () => image }] },
    });
    expect(onPasteImages).toHaveBeenCalledWith([image]);
  });

  it('preserves normal text paste and does not import non-image files', async () => {
    const user = userEvent.setup();
    const onPasteImages = vi.fn();
    render(<AiComposerSeat phase="active" status="idle" onPasteImages={onPasteImages} />);
    const textbox = screen.getByRole('textbox');
    await user.click(textbox);
    await user.paste('Pasted text');
    expect(textbox).toHaveValue('Pasted text');
    expect(fireEvent.paste(textbox, {
      clipboardData: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })], items: [] },
    })).toBe(true);
    expect(onPasteImages).not.toHaveBeenCalled();
  });

  it.each([{ imageBusy: true }, { imageLocked: true }, { unavailableReason: 'Unavailable' }])(
    'does not import images when the composer cannot accept them: %o', (props) => {
      const onPasteImages = vi.fn();
      render(<AiComposerSeat phase="active" status="idle" onPasteImages={onPasteImages} {...props} />);
      fireEvent.paste(screen.getByRole('textbox'), {
        clipboardData: { files: [new File(['image'], 'screenshot.png', { type: 'image/png' })], items: [] },
      });
      expect(onPasteImages).not.toHaveBeenCalled();
    },
  );

  it.each([['MacIntel', '⌘V'], ['Win32', 'Ctrl+V']])('shows the image paste shortcut for %s', (platform, shortcut) => {
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    try {
      render(<AiComposerSeat phase="active" status="idle" />);
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toContain(`${shortcut} Paste images`);
    } finally {
      platformSpy.mockRestore();
    }
  });

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

  it('ignores Safari-style Enter immediately after composition ends', () => {
    const submit = vi.fn();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    render(<Harness initial={createAiComposerState({ draft: '中文输入' })} onSubmitGesture={submit} />);
    const textbox = screen.getByRole('textbox');

    fireEvent.compositionStart(textbox);
    fireEvent.keyDown(textbox, { key: 'Enter' });
    fireEvent.compositionEnd(textbox);
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();

    clock.mockReturnValue(111);
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith('keyboard', false);
    clock.mockRestore();
  });

  it('selects persisted provider profiles and supported reasoning effort', async () => {
    const user = userEvent.setup();
    const deepseek = {
      id: 'deepseek-profile', preset: 'deepseek' as const, name: 'DeepSeek',
      kind: 'openAiCompatible' as const, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4', requiresApiKey: true,
    };
    const openai = {
      id: 'openai-profile', preset: 'openai' as const, name: 'OpenAI',
      kind: 'openAi' as const, baseUrl: 'https://api.openai.com',
      model: 'gpt-5.6', requiresApiKey: true,
    };
    useAiSettingsStore.setState({ providers: [deepseek, openai], defaultProviderId: deepseek.id });
    render(<AiComposerModelSelector />);

    await user.click(screen.getByRole('button', { name: /Model selection: deepseek-v4/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Model.*deepseek-v4/ }));
    expect(screen.getByText('DeepSeek')).toBeVisible();
    expect(screen.getByText('OpenAI')).toBeVisible();
    await user.click(screen.getByRole('menuitemradio', { name: 'gpt-5.6' }));
    expect(useAiSettingsStore.getState().defaultProviderId).toBe(openai.id);

    await user.click(screen.getByRole('button', { name: /Model selection: gpt-5.6/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Reasoning effort.*Default/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(useAiSettingsStore.getState().providers.find((item) => item.id === openai.id))
      .toMatchObject({ reasoningEffort: 'high' });
  });

  it('offers MiniMax M3 thinking as an on/off control', async () => {
    const user = userEvent.setup();
    const minimax = {
      id: 'minimax-profile', preset: 'minimax' as const, name: 'MiniMax',
      kind: 'openAiCompatible' as const, baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3', requiresApiKey: true,
    };
    useAiSettingsStore.setState({ providers: [minimax], defaultProviderId: minimax.id });
    render(<AiComposerModelSelector />);

    await user.click(screen.getByRole('button', { name: /Model selection: MiniMax-M3/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Reasoning effort.*Default/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'On' }));

    expect(useAiSettingsStore.getState().providers[0])
      .toMatchObject({ reasoningEffort: 'on' });
  });

  it('shows the Runtime-backed context ring after model selection with an honest breakdown', async () => {
    const user = userEvent.setup();
    render(
      <AiComposerSeat
        phase="active"
        status="idle"
        defaultDraft=""
        modelControl={<button type="button">Model fixture</button>}
        contextUsage={{
          usedTokens: 61_800,
          contextWindow: 1_000_000,
          source: 'estimated',
          breakdown: { systemTokens: 1_700, toolsTokens: 6_600, messageTokens: 45_800 },
        }}
      />,
    );
    const model = screen.getByRole('button', { name: 'Model fixture' });
    const meter = screen.getByRole('button', { name: 'Estimated context usage 6%' });
    expect(model.compareDocumentPosition(meter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(meter);
    const panel = screen.getByRole('dialog', { name: 'Context usage' });
    expect(panel).toHaveTextContent('Context used6%~61.8K / 1M');
    expect(panel).toHaveTextContent('System prompt~1.7K');
    expect(panel).toHaveTextContent('Tools~6.6K');
    expect(panel).toHaveTextContent('Conversation messages~45.8K');
    expect(panel).toHaveTextContent('Total usage and categories are stable Runtime estimates.');
    expect(document.querySelectorAll('.ai-context-meter-bar > span')).toHaveLength(3);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Context usage' })).toBeNull();
  });

  it('omits the context meter when the protocol has no capacity and usage pair', () => {
    render(
      <AiComposerSeat
        phase="active"
        status="idle"
        defaultDraft=""
        modelControl={<button type="button">Model fixture</button>}
      />,
    );
    expect(screen.queryByRole('button', { name: /context usage/i })).toBeNull();
  });

  it('uses an unambiguous Stop button for an empty running Composer', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    render(<Harness initial={createAiComposerState({
      phase: 'running', runtimeStatus: 'running',
      sessionId: 'session-1', draft: '',
    })} onStop={stop} />);

    await user.click(screen.getByRole('button', { name: 'Stop task' }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Queue for next turn' })).toBeNull();
  });

  it('keeps approval drafts visible but disabled without implementing takeover actions', () => {
    render(<Harness initial={createAiComposerState({
      phase: 'waitingApproval', runtimeStatus: 'waiting', waitingApproval: true,
      sessionId: 'session-1', draft: 'keep this draft',
    })} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('keep this draft');
    expect(screen.getByText('Waiting for approval')).toBeVisible();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('renders Runtime Inbox with lane, state, and Phase 6 mutation controls', () => {
    render(<Harness initial={createAiComposerState()} />);
    const queue = screen.getByRole('region', { name: 'Queued input' });
    expect(queue).toBeVisible();
    expect(screen.getByText('Run tests next')).toBeVisible();
    expect(queue).toHaveTextContent('Next turn · Queued');
    expect(screen.queryByText('Do not restart')).toBeNull();
    expect(queue).not.toHaveTextContent('Claimed');
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
