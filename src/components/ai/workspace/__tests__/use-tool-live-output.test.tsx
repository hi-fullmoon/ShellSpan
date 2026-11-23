import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AiToolRow } from '../ai-tool-presentation';
import { toolLiveOutputStore } from '../use-tool-live-output';

function makeTerminalTool(
  overrides: Partial<AiConversationNodeOf<'tool'>> = {},
): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: 'tool:call-live-1',
    sourceKind: 'agent',
    sessionId: 'agent-sess-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 2,
    lastSeq: 3,
    timestamp: new Date().toISOString(),
    callId: 'call-live-1',
    name: 'run_terminal_command',
    nativeName: 'exec_command',
    title: null,
    summary: '',
    state: 'running',
    effect: 'readOnly',
    durationMs: null,
    detailRef: { kind: 'agentTool', sessionId: 'agent-sess-1', callId: 'call-live-1', turnId: 'turn-1', stepId: 'step-1' },
    evidenceRefs: [],
    input: { command: 'docker build .' },
    output: null,
    error: null,
    target: { kind: 'local', targetId: 'local-1', sessionId: 'term-1' },
    idempotency: 'yes',
    approval: null,
    ...overrides,
  };
}

describe('tool live output subscription and terminal card presentation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    toolLiveOutputStore.reset();
    useAppStore.setState({ locale: 'en-US', activeSection: 'workbench' });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    await initI18n('en-US');
  });

  afterEach(() => {
    toolLiveOutputStore.reset();
    cleanup();
    vi.restoreAllMocks();
  });

  it('auto-expands on live output, drops out-of-order revisions, and switches in place on completion', () => {
    const runningNode = makeTerminalTool();
    const { container, rerender } = render(<AiToolRow node={runningNode} />);

    // Collapsed initially before any live output arrives.
    expect(container.querySelector('.ai-terminal-block')).toBeNull();

    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 2,
        tail: 'Step 1/4: pull base image\nStep 2/4: install deps\n',
        totalBytes: 51,
        truncated: true,
        alternateScreen: false,
      });
    });

    const block = container.querySelector('.ai-terminal-block');
    expect(block).not.toBeNull();
    expect(block).toHaveAttribute('data-live-output', 'true');
    expect(container.querySelector('[data-ai-live-truncated]')).toHaveTextContent('Showing recent output');
    expect(container.querySelector('.ai-terminal-transcript')).toHaveTextContent('Step 2/4: install deps');
    const transcriptBefore = container.querySelector('.ai-terminal-transcript');

    // Out-of-order older revision must be ignored.
    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 1,
        tail: 'stale line\n',
        totalBytes: 11,
        truncated: false,
        alternateScreen: false,
      });
    });
    expect(container.querySelector('.ai-terminal-transcript')).toHaveTextContent('Step 2/4: install deps');
    expect(container.querySelector('.ai-terminal-transcript')).not.toHaveTextContent('stale line');

    // Final tool result replaces live preview in place and clears live store entry.
    rerender(
      <AiToolRow
        node={makeTerminalTool({
          state: 'succeeded',
          lastSeq: 5,
          output: { stdout: 'Step 4/4: done\n', exitCode: 0 },
        })}
      />,
    );
    expect(container.querySelector('.ai-terminal-block')).not.toHaveAttribute('data-live-output');
    expect(container.querySelector('.ai-terminal-transcript')).toBe(transcriptBefore);
    expect(container.querySelector('.ai-terminal-transcript')).toHaveTextContent('Step 4/4: done');
    expect(toolLiveOutputStore.get('agent-sess-1', 'call-live-1')).toBeNull();
  });

  it('respects user manual collapse while live output keeps arriving', () => {
    const runningNode = makeTerminalTool();
    const { container } = render(<AiToolRow node={runningNode} />);

    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 1,
        tail: 'line 1\n',
        totalBytes: 7,
        truncated: false,
        alternateScreen: false,
      });
    });
    expect(container.querySelector('.ai-terminal-block')).not.toBeNull();

    fireEvent.click(container.querySelector<HTMLButtonElement>('.ai-tool-row')!);
    expect(container.querySelector('.ai-terminal-block')).toBeNull();

    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 2,
        tail: 'line 1\nline 2\n',
        totalBytes: 14,
        truncated: false,
        alternateScreen: false,
      });
    });
    expect(container.querySelector('.ai-terminal-block')).toBeNull();
  });

  it('shows interactive program notice on alternateScreen without a focus terminal button', () => {
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'term-1',
        title: 'prod-web-01',
        host: '10.0.0.10',
        port: 22,
        username: 'ops',
        status: 'connected',
      }],
      activeSessionId: 'other-term',
    });

    const boundNode = makeTerminalTool({
      nativeName: 'terminal_execute',
      input: { command: 'top' },
    });
    const { container } = render(<AiToolRow node={boundNode} />);

    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 1,
        tail: '',
        totalBytes: 120,
        truncated: false,
        alternateScreen: true,
      });
    });

    expect(container.querySelector('[data-ai-terminal-interactive]')).toHaveTextContent('Interactive program running');
    expect(container.querySelector('.ai-terminal-focus-button')).toBeNull();
  });

  it('does not clear an active tool call live output when an older completed card shares the same callId', () => {
    const completedOlderNode = makeTerminalTool({
      key: 'tool:older',
      turnId: 'turn-1',
      stepId: 'step-1',
      state: 'succeeded',
      output: { stdout: 'older output\n', exitCode: 0 },
    });
    const runningNewerNode = makeTerminalTool({
      key: 'tool:newer',
      turnId: 'turn-2',
      stepId: 'step-1',
      state: 'running',
    });
    const { container } = render(
      <>
        <AiToolRow node={completedOlderNode} />
        <AiToolRow node={runningNewerNode} />
      </>,
    );

    act(() => {
      toolLiveOutputStore.ingest({
        sessionId: 'agent-sess-1',
        callId: 'call-live-1',
        revision: 1,
        tail: 'fresh live output\n',
        totalBytes: 18,
        truncated: false,
        alternateScreen: false,
      });
    });

    expect(toolLiveOutputStore.get('agent-sess-1', 'call-live-1')?.tail).toBe('fresh live output\n');
    expect(container.querySelector('.ai-terminal-block[data-live-output="true"]')).not.toBeNull();
  });
});
