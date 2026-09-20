import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConversationNodeList,
  aiAskConversationNodeRenderers,
  aiConversationNodeRenderers,
  type AiConversationNodeRendererMap,
} from '@/components/ai/workspace/ai-conversation-node-seat';
import { classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  agentSessionEventFixture,
  agentSessionFailedEventFixture,
  agentSessionRunningEventFixture,
  sessionEvent,
} from '@/test/fixtures/agent-session';
import '@/components/ai/styles/styles.css';

function toolNode(
  changes: Partial<AiConversationNodeOf<'tool'>> = {},
): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: 'tool:fixture',
    sourceKind: 'agent',
    sessionId: 'session-fixture',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 1,
    timestamp: '2026-09-03T00:00:00.000Z',
    callId: 'call-fixture',
    name: 'terminal.exec',
    nativeName: 'exec_command',
    title: null,
    summary: 'Run diagnostics',
    state: 'running',
    effect: 'readOnly',
    durationMs: null,
    detailRef: { kind: 'agentTool', sessionId: 'session-fixture', callId: 'call-fixture' },
    evidenceRefs: [],
    input: { command: 'printf ready', explanation: 'Run diagnostics', cwd: '/srv/app' },
    output: null,
    error: null,
    target: null,
    idempotency: null,
    approval: null,
    ...changes,
  };
}

function contextNode(
  kind: AiConversationNodeOf<'contextInjection'>['provenance']['kind'],
): AiConversationNodeOf<'contextInjection'> {
  return {
    kind: 'contextInjection',
    key: `context:${kind}`,
    sourceKind: 'agent',
    sessionId: 'session-context',
    turnId: 'turn-context',
    stepId: 'step-context',
    firstSeq: 1,
    lastSeq: 1,
    timestamp: '2026-09-19T00:00:00.000Z',
    messageId: `message:${kind}`,
    content: `Content for ${kind}`,
    provenance: { kind, label: `Label for ${kind}`, producerId: `producer:${kind}` },
  };
}

function assistantText(node: AiConversationNodeOf<'assistantMessage'>): string {
  return node.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

describe('AiConversationNodeList', () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  it('animates Ask reasoning height while preserving the collapsible contract', async () => {
    const user = userEvent.setup();
    const reasoning: AiConversationNodeOf<'reasoning'> = {
      kind: 'reasoning',
      key: 'reasoning:ask-motion',
      sourceKind: 'agent',
      sessionId: 'ask-motion-session',
      turnId: 'ask-motion-turn',
      stepId: null,
      firstSeq: 1,
      lastSeq: 2,
      timestamp: '2026-09-09T00:00:00.000Z',
      requestId: 'ask-motion-request',
      summary: 'Check the facts',
      content: 'Check the facts before answering.',
      state: 'completed',
    };
    const { container } = render(
      <div className="ai-panel-shell">
        <AiConversationNodeList nodes={[reasoning]} renderers={aiAskConversationNodeRenderers} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Thought' }));
    const panel = container.querySelector<HTMLElement>(
      '.ai-ask-reasoning-row [data-slot="collapsible-content"]',
    );
    expect(panel).toBeInTheDocument();
    expect(getComputedStyle(panel!).height).toBe('var(--collapsible-panel-height)');
    expect(getComputedStyle(panel!).overflow).toBe('hidden');
    expect(getComputedStyle(panel!).transitionProperty).toBe('height, opacity');
  });

  it('renders Agent projections through the keyed node seat', async () => {
    const agentNodes = projectAgentChatNodes(agentSessionEventFixture);
    render(<AiConversationNodeList nodes={agentNodes} />);

    expect(screen.getByText('Check nginx now.')).toBeVisible();
    expect(document.querySelector('[data-ai-node-key="turn-process:turn-1"]'))
      .toHaveAttribute('data-ai-node-kind', 'turnProcess');
    expect(document.querySelector('[data-ai-node-key="tool:turn-1:step-1:call-health"]')).not.toBeInTheDocument();
    const process = screen.getByRole('button', { name: 'Process complete' });
    expect(process).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Command: Confirm nginx is active.' })).not.toBeInTheDocument();
    });
    fireEvent.click(process);
    expect(await screen.findByRole('button', { name: /^Command:/ })).toBeVisible();
  });

  it('keeps lifecycle copy out of Conversation and terminal errors inside Turn Process', () => {
    const nodes = projectAgentChatNodes(agentSessionFailedEventFixture);
    const { container } = render(<AiConversationNodeList nodes={nodes} />);
    const process = nodes.find((node) => node.kind === 'turnProcess');

    expect(container.querySelector('[data-ai-node-kind="lifecycleMarker"]'))
      .not.toBeInTheDocument();
    expect(process?.kind === 'turnProcess' ? process.children : []).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: 'Provider connection failed.',
      }),
    ]);
    expect(container.querySelectorAll('[data-ai-node-key]')).toHaveLength(nodes.length);
  });

  it.each([
    'outputLimit',
    'outputLimit: attempt=1 maxAttempts=3 kind=Terminal code=OUTPUT_LIMIT',
  ])('renders an actionable message for %s', (message) => {
    const error: AiConversationNodeOf<'error'> = {
      kind: 'error',
      key: 'error:output-limit',
      sourceKind: 'agent',
      sessionId: 'session-output-limit',
      turnId: 'turn-output-limit',
      stepId: 'step-output-limit',
      firstSeq: 1,
      lastSeq: 1,
      timestamp: '2026-09-18T00:00:00.000Z',
      scope: 'session',
      message,
      code: null,
      state: 'failed',
    };

    const { container } = render(<AiConversationNodeList nodes={[error]} />);

    expect(within(screen.getByRole('alert')).getByText(
      'The model still reached its output limit after reducing the step size. Saved changes were kept; unfinished tool calls were not executed. Check the model output limit in provider settings before continuing.',
    )).toBeVisible();
    expect(screen.queryByText(/maxAttempts/)).not.toBeInTheDocument();
    expect(container.querySelector('.ai-turn-error')).toHaveClass('grid-cols-[16px_minmax(0,1fr)_auto]', 'gap-1');
  });

  it('renders output-limit continuation as a readable status without an error count', () => {
    const nodes = projectAgentChatNodes([
      sessionEvent(0, { type: 'turn/start', turnId: 'turn-recovery' }),
      sessionEvent(1, { type: 'step/start', turnId: 'turn-recovery', stepId: 'step-recovery' }),
      sessionEvent(2, { type: 'step/end', turnId: 'turn-recovery', stepId: 'step-recovery', data: { reason: 'outputLimitContinuation' } }),
    ]);
    render(<AiConversationNodeList nodes={nodes} />);
    expect(screen.getByText('Continuing in smaller steps (1/2)')).toBeVisible();
    expect(screen.getByText('Output limit reached. Checking saved work before continuing.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/outputLimitContinuation|Request failed|1 error/)).not.toBeInTheDocument();
  });

  it('hides internal runtime, Agent instruction, and Skills catalog context', () => {
    const hiddenContexts = [
      contextNode('runtime'),
      contextNode('agent-instructions'),
      contextNode('skill-catalog'),
    ];
    const pluginContext = contextNode('plugin');
    const process: AiConversationNodeOf<'turnProcess'> = {
      kind: 'turnProcess',
      key: 'turn-process:context-visibility',
      sourceKind: 'agent',
      sessionId: 'session-context',
      turnId: 'turn-context',
      stepId: null,
      firstSeq: 1,
      lastSeq: 4,
      timestamp: '2026-09-19T00:00:00.000Z',
      status: 'running',
      answerGeneration: 'context-visibility-generation',
      hasStartBoundary: true,
      hasEndBoundary: false,
      childKeys: [...hiddenContexts, pluginContext].map((context) => context.key),
      children: [...hiddenContexts, pluginContext],
    };

    const { rerender } = render(<AiConversationNodeList nodes={[process]} />);

    expect(screen.queryByRole('button', { name: 'Runtime context' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent instructions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skill catalog' })).not.toBeInTheDocument();
    for (const context of hiddenContexts) {
      expect(screen.queryByText(context.content)).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Plugin context' })).toBeVisible();

    rerender(<AiConversationNodeList nodes={[{
      ...process,
      lastSeq: 5,
      childKeys: hiddenContexts.map((context) => context.key),
      children: hiddenContexts,
    }]} />);
    expect(screen.queryByRole('button', { name: 'Processing' })).not.toBeInTheDocument();
  });

  it('rerenders only the changed streaming node across 20 projection revisions', () => {
    const projected = projectAgentChatNodes(agentSessionRunningEventFixture);
    const user = projected.find((node) => node.kind === 'userMessage');
    const assistant = projected.find((node) => node.kind === 'assistantMessage');
    if (!user || user.kind !== 'userMessage' || !assistant || assistant.kind !== 'assistantMessage') {
      throw new Error('Agent fixture did not project the expected messages');
    }
    const renderUser = vi.fn(({ node }: { node: typeof user }) => <span>{node.content}</span>);
    const renderAssistant = vi.fn(({ node }: { node: typeof assistant }) => (
      <span>{assistantText(node)}</span>
    ));
    const renderers = {
      ...aiConversationNodeRenderers,
      userMessage: renderUser,
      assistantMessage: renderAssistant,
    } satisfies AiConversationNodeRendererMap;
    const { rerender } = render(
      <AiConversationNodeList nodes={[user, assistant]} renderers={renderers} />,
    );

    for (let revision = 1; revision <= 20; revision += 1) {
      const text = `${assistantText(assistant)}${'.'.repeat(revision)}`;
      rerender(
        <AiConversationNodeList
          nodes={[
            { ...user },
            {
              ...assistant,
              lastSeq: assistant.lastSeq + revision,
              blocks: [{ type: 'text', text }],
            },
          ]}
          renderers={renderers}
        />,
      );
    }

    expect(renderUser).toHaveBeenCalledTimes(1);
    expect(renderAssistant).toHaveBeenCalledTimes(21);
  });

  it('keeps 50 tool payloads out of the conversation DOM until details open', () => {
    const process = projectAgentChatNodes(agentSessionEventFixture)
      .find((node) => node.kind === 'turnProcess');
    const base = process?.kind === 'turnProcess'
      ? process.children.find((node) => node.kind === 'tool')
      : undefined;
    if (!base || base.kind !== 'tool') throw new Error('Agent fixture did not project a tool');
    const sentinel = 'TOOL_INPUT_MUST_STAY_LAZY';
    const tools = Array.from({ length: 50 }, (_, index) => ({
      ...base,
      key: `tool:perf-${index}`,
      callId: `perf-${index}`,
      input: { payload: sentinel, index },
    }));
    const { container } = render(<AiConversationNodeList nodes={tools} />);

    expect(container.querySelectorAll('[data-ai-node-kind="tool"]')).toHaveLength(50);
    expect(container).not.toHaveTextContent(sentinel);
  });

  it('renders the user bubble and shell-free Markdown assistant with message copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const userNode: AiConversationNodeOf<'userMessage'> = {
      kind: 'userMessage',
      key: 'user:layout',
      sourceKind: 'agent',
      sessionId: 'agent-layout',
      turnId: 'request-layout',
      stepId: null,
      firstSeq: 0,
      lastSeq: 0,
      timestamp: '2026-09-03T00:00:00.000Z',
      messageId: 'user-layout',
      content: 'Keep this compact.',
      delivery: 'committed',
    };
    const assistantNode: AiConversationNodeOf<'assistantMessage'> = {
      kind: 'assistantMessage',
      key: 'assistant:layout',
      sourceKind: 'agent',
      sessionId: 'agent-layout',
      turnId: 'request-layout',
      stepId: null,
      firstSeq: 1,
      lastSeq: 1,
      timestamp: '2026-09-03T00:00:01.000Z',
      messageId: 'assistant-layout',
      requestId: 'request-layout',
      blocks: [{ type: 'text', text: '## Safe result\n\nThe service is **ready**.' }],
      state: 'completed',
    };
    const { rerender } = render(<AiConversationNodeList nodes={[
      userNode, { ...assistantNode, state: 'streaming' },
    ]} />);
    expect(within(screen.getByRole('article', { name: 'AI assistant message' }))
      .queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Your message' }))
      .getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    rerender(<AiConversationNodeList nodes={[userNode, assistantNode]} />);

    const userArticle = screen.getByRole('article', { name: 'Your message' });
    const assistantArticle = screen.getByRole('article', { name: 'AI assistant message' });
    const userCopyButton = within(userArticle).getByRole('button', { name: 'Copy' });
    expect(userCopyButton).toHaveClass('grid', 'place-items-center', 'p-0');
    expect(userArticle.querySelector('.ai-message-bubble-user')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-assistant')).toBeInTheDocument();
    expect(assistantArticle.querySelector('.ai-message-bubble-content')).toHaveClass('p-0');
    expect(within(assistantArticle).getByRole('heading', { name: 'Safe result' })).toBeVisible();

    await user.click(within(assistantArticle).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(assistantText(assistantNode));
    expect(await within(assistantArticle).findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('renders projected reasoning as a semantic nested disclosure', async () => {
    const user = userEvent.setup();
    const reasoning: AiConversationNodeOf<'reasoning'> = {
      kind: 'reasoning',
      key: 'reasoning:fixture',
      sourceKind: 'agent',
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 2,
      timestamp: '2026-09-03T00:00:00.000Z',
      requestId: 'request-1',
      summary: 'Inspect the service state',
      content: 'Inspect the service state\nChoose the safe read-only command.',
      state: 'completed',
    };
    const { container } = render(<AiConversationNodeList nodes={[reasoning]} />);

    const disclosure = screen.getByRole('button', { name: 'Reasoning Inspect the service state' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(getComputedStyle(disclosure.querySelector('.ai-disclosure-leading > svg:first-child')!).translate).toBe('0 -1px');
    expect(container.querySelector('.ai-reasoning-body')).toBeNull();
    await user.click(disclosure);
    expect(container.querySelector('.ai-reasoning-body'))
      .toHaveTextContent('Inspect the service state Choose the safe read-only command.');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('[data-ai-running-indicator]')).toHaveLength(0);
  });

  it.each([
    ['terminal.exec', null, 'terminal'],
    ['read_terminal', null, 'terminal'],
    ['write_terminal_input', null, 'terminal'],
    ['write_stdin', null, 'terminal'],
    ['read_file', null, 'read'],
    ['search_text', null, 'search'],
    ['web.fetch', null, 'web'],
    ['apply_patch', null, 'edit'],
    ['write_file', null, 'write'],
    ['python', null, 'code'],
    ['provider.tool', 'write_file', 'write'],
    ['provider.tool', 'mcp::server::already_processed', 'generic'],
    ['vendor.future_capability', null, 'generic'],
  ] as const)('classifies %s with the %s native identity as %s', (name, nativeName, variant) => {
    expect(classifyAiTool(name, nativeName)).toBe(variant);
  });

  it('uses real native file contracts for paths, diff totals, and replacement uncertainty', async () => {
    const user = userEvent.setup();
    const write = toolNode({
      key: 'tool:write',
      callId: 'call-write',
      name: 'provider.tool',
      nativeName: 'write_file',
      title: 'write_file',
      summary: 'write_file completed',
      state: 'succeeded',
      durationMs: 24,
      input: {
        path: 'todo-app/package.json',
        content: '{\n  "name": "todo-app"\n}\n',
        precondition: { mustNotExist: true },
      },
      output: { written: true, operation: 'create', path: 'todo-app/package.json' },
    });
    const longLine = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
    const patch = [
      '--- original',
      '+++ modified',
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      ' kept',
      `+${longLine}`,
      '',
    ].join('\n');
    const edit = toolNode({
      key: 'tool:edit',
      callId: 'call-edit',
      name: 'provider.tool',
      nativeName: 'apply_patch',
      title: 'apply_patch',
      summary: 'Applied, re-read, and verified the exact native patch.',
      state: 'succeeded',
      input: {
        patch,
        preconditions: [{ path: 'todo-app/src/app.ts', sha256: 'a'.repeat(64) }],
      },
      output: {
        applied: true,
        diff: patch,
        files: [{ path: 'todo-app/src/app.ts', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) }],
      },
    });
    const replace = toolNode({
      key: 'tool:replace',
      callId: 'call-replace',
      name: 'write_file',
      nativeName: 'write_file',
      title: 'write_file',
      summary: 'Wrote, re-read, and verified the exact UTF-8 file.',
      state: 'succeeded',
      input: {
        path: 'todo-app/tsconfig.json',
        content: '{\n  "strict": true\n}\n',
        precondition: { sha256: 'c'.repeat(64) },
      },
      output: { written: true, operation: 'replace', path: 'todo-app/tsconfig.json' },
    });
    const generic = toolNode({
      key: 'tool:orchestration',
      callId: 'call-orchestration',
      name: 'provider.future_tool',
      nativeName: null,
      title: 'Agent orchestration',
      summary: 'Delegate repository inspection',
      state: 'succeeded',
      input: { description: 'Delegate repository inspection' },
    });
    const { container } = render(<AiConversationNodeList nodes={[write, edit, replace, generic]} />);

    const writeSeat = container.querySelector('[data-ai-node-key="tool:write"]') as HTMLElement;
    const writeRow = within(writeSeat).getByRole('button', {
      name: 'Write: todo-app/package.json +3 -0',
    });
    expect(writeSeat.querySelector('[data-tool-variant="write"]')).toBeInTheDocument();
    expect(writeRow).toHaveTextContent('Write');
    expect(writeRow).toHaveTextContent('todo-app/package.json');
    expect(writeRow.querySelector('.ai-tool-diff-stat')).toHaveTextContent('+3 -0');
    const writeMeta = writeRow.querySelector('.ai-tool-meta');
    expect(writeMeta).toHaveClass('inline-flex', 'items-baseline', 'gap-2');
    expect(writeMeta).toHaveTextContent('+3 -024 ms');
    expect(writeRow).not.toHaveTextContent('write_file completed');

    const editSeat = container.querySelector('[data-ai-node-key="tool:edit"]') as HTMLElement;
    const editRow = within(editSeat).getByRole('button', {
      name: 'Edit: todo-app/src/app.ts +2 -1',
    });
    await user.click(editRow);
    const diff = editSeat.querySelector('[data-ai-tool-view="diff"]') as HTMLElement;
    expect(diff).toHaveTextContent('todo-app/src/app.ts');
    expect(diff.querySelectorAll('[data-diff="removed"]')).toHaveLength(1);
    expect(diff.querySelectorAll('[data-diff="added"]')).toHaveLength(2);
    expect(Array.from(diff.querySelectorAll('[data-diff]'), (line) => [
      line.getAttribute('data-diff'), line.textContent,
    ])).toEqual([
      ['removed', '- old'],
      ['added', '+ new'],
      ['context', '  kept'],
      ['added', `+ ${longLine}`],
    ]);
    expect(diff.querySelector('section')).toHaveClass('min-w-0', 'max-w-full');
    expect(diff.querySelector('.ai-block-banner')).toHaveClass('px-2.5', 'py-1.5');
    expect(diff.querySelector('.ai-diff-body')).toHaveClass(
      'min-w-0', 'max-w-full', 'overflow-auto', 'px-2.5', 'py-2',
      'whitespace-pre-wrap', '[overflow-wrap:anywhere]',
    );
    expect(diff.querySelector('.ai-diff-body')).not.toHaveClass('whitespace-pre');
    expect(diff.querySelectorAll('[data-diff="added"]')[1]?.textContent).toBe(`+ ${longLine}`);

    const replaceSeat = container.querySelector('[data-ai-node-key="tool:replace"]') as HTMLElement;
    const replaceRow = within(replaceSeat).getByRole('button', {
      name: 'Write: todo-app/tsconfig.json',
    });
    expect(replaceRow.querySelector('.ai-tool-diff-stat')).toBeNull();
    expect(within(container.querySelector('[data-ai-node-key="tool:orchestration"]') as HTMLElement)
      .getByRole('button', { name: 'Agent orchestration: Delegate repository inspection' }))
      .toBeVisible();
  });

  it('shows only changed lines in structured edit totals while keeping context and deletions in order', async () => {
    const user = userEvent.setup();
    const edit = toolNode({
      key: 'tool:structured-edit',
      name: 'edit_file',
      nativeName: 'edit_file',
      state: 'succeeded',
      input: { path: 'src/example.ts' },
      output: {
        diffs: [{
          path: 'src/example.ts',
          oldText: 'same\nold\nkeep\nremove\n',
          newText: 'same\nnew\nkeep\n',
        }],
      },
    });
    const { container } = render(<AiConversationNodeList nodes={[edit]} />);
    await user.click(screen.getByRole('button', { name: 'Edit: src/example.ts +1 -2' }));

    expect(Array.from(container.querySelectorAll('[data-ai-tool-view="diff"] [data-diff]'), (line) => [
      line.getAttribute('data-diff'), line.textContent,
    ])).toEqual([
      ['context', '  same'],
      ['removed', '- old'],
      ['added', '+ new'],
      ['context', '  keep'],
      ['removed', '- remove'],
    ]);
  });

  it('keeps a late change visible in compact mode without comparing unchanged large file sections', async () => {
    const user = userEvent.setup();
    const shared = `${Array.from({ length: 1_800 }, (_, index) => `same-${index.toString().padStart(4, '0')}`).join('\n')}\n`;
    const edit = toolNode({
      key: 'tool:late-edit', name: 'edit_file', nativeName: 'edit_file', state: 'succeeded',
      input: { path: 'src/large.ts' },
      output: { diffs: [{ path: 'src/large.ts', oldText: `${shared}old\nend\n`, newText: `${shared}new\nend\n` }] },
    });
    const { container } = render(<AiConversationNodeList nodes={[edit]} />);
    await user.click(screen.getByRole('button', { name: 'Edit: src/large.ts +1 -1' }));

    const diff = container.querySelector('[data-ai-tool-view="diff"]') as HTMLElement;
    const visible = Array.from(diff.querySelectorAll('[data-diff]'), (line) => line.textContent);
    expect(visible).toEqual(['  same-1797', '  same-1798', '  same-1799', '- old', '+ new', '  end']);
    expect(diff.querySelector('[data-diff-simplified]')).toBeNull();
  });

  it('bounds large unrelated replacements and labels their simplified diff without exact totals', async () => {
    const user = userEvent.setup();
    const oldText = `${Array.from({ length: 2_000 }, (_, index) => `before-${index}`).join('\n')}\n`;
    const newText = `${Array.from({ length: 2_000 }, (_, index) => `after-${index}`).join('\n')}\n`;
    const edit = toolNode({
      key: 'tool:large-replacement', name: 'edit_file', nativeName: 'edit_file', state: 'succeeded',
      input: { path: 'src/replaced.ts' },
      output: { diffs: [{ path: 'src/replaced.ts', oldText, newText }] },
    });
    const { container } = render(<AiConversationNodeList nodes={[edit]} />);
    const row = screen.getByRole('button', { name: 'Edit: src/replaced.ts' });
    expect(row.querySelector('.ai-tool-diff-stat')).toBeNull();
    await user.click(row);

    const diff = container.querySelector('[data-ai-tool-view="diff"]') as HTMLElement;
    expect(diff.querySelector('[data-diff-simplified]')).toHaveTextContent(
      'Large change shown as a whole block; line totals are omitted.',
    );
    expect(diff.querySelectorAll('[data-diff="removed"]')).toHaveLength(8);
    expect(diff.querySelectorAll('[data-diff="added"]')).toHaveLength(8);
  });

  it('covers running, completed, and failed tool rows, inline expansion, details, and fallback', async () => {
    const user = userEvent.setup();
    const openTool = vi.fn();
    const running = toolNode();
    const completed = toolNode({
      key: 'tool:read',
      callId: 'call-read',
      name: 'read_file',
      summary: '/srv/app/config.toml',
      state: 'succeeded',
      durationMs: 125,
      input: { path: '/srv/app/config.toml' },
      output: 'enabled = true',
    });
    const failed = toolNode({
      key: 'tool:future',
      callId: 'call-future',
      name: 'vendor.future_capability',
      nativeName: null,
      summary: 'Provider rejected the call',
      state: 'failed',
      input: { opaque: true },
      output: { message: 'Provider rejected the call' },
      error: 'Provider rejected the call',
    });
    const { container } = render(
      <AiConversationNodeList nodes={[running, completed, failed]} onOpenTool={openTool} />,
    );
    const runningSeat = container.querySelector('[data-ai-node-key="tool:fixture"]') as HTMLElement;
    const completedSeat = container.querySelector('[data-ai-node-key="tool:read"]') as HTMLElement;
    const failedSeat = container.querySelector('[data-ai-node-key="tool:future"]') as HTMLElement;

    expect(runningSeat.querySelector('[data-tool-state="running"]')).toHaveAttribute('data-tool-variant', 'terminal');
    expect(getComputedStyle(runningSeat.querySelector('.ai-tool-row .ai-disclosure-leading > svg:first-child')!).translate).toBe('0 -1px');
    expect(completedSeat.querySelector('[data-tool-state="succeeded"]')).toHaveAttribute('data-tool-variant', 'read');
    expect(completedSeat).toHaveTextContent('125 ms');
    expect(failedSeat.querySelector('[data-tool-state="failed"]')).toHaveAttribute('data-tool-fallback');
    expect(within(failedSeat).getByRole('status')).toHaveTextContent('Failed');

    await user.click(within(runningSeat).getByRole('button', { name: 'Command: Run diagnostics' }));
    expect(runningSeat.querySelector('[data-ai-tool-view="terminal"]')).toBeInTheDocument();
    const toolPanel = runningSeat.querySelector<HTMLElement>(
      '.ai-tool-row-root > [data-slot="collapsible-content"]',
    );
    expect(getComputedStyle(toolPanel!).transitionProperty).toBe('height, opacity');
    expect(getComputedStyle(toolPanel!).overflow).toBe('hidden');
    const inspect = within(runningSeat).getByRole('button', { name: 'Open details for terminal.exec' });
    await user.click(inspect);
    expect(openTool).toHaveBeenCalledWith(running);

    await user.click(within(failedSeat).getByRole('button', { name: 'Tool call: Provider rejected the call' }));
    expect(failedSeat.querySelector('[data-ai-tool-view="generic"]')).toHaveTextContent('Provider rejected the call');
  });

  it('renders a produced artifact and preserves its details navigation', async () => {
    const user = userEvent.setup();
    const openArtifact = vi.fn();
    const artifact: AiConversationNodeOf<'artifact'> = {
      kind: 'artifact',
      key: 'artifact:report',
      sourceKind: 'agent',
      sessionId: 'session-fixture',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 1,
      timestamp: '2026-09-03T00:00:00.000Z',
      artifactId: 'report',
      artifactKind: 'text',
      title: 'Deployment report',
      sizeBytes: 42,
      mediaType: 'text/plain',
      sha256: 'abc123',
      sensitivity: 'internal',
    };
    const { container } = render(<AiConversationNodeList nodes={[artifact]} onOpenArtifact={openArtifact} />);

    expect(screen.getByText('Produced')).toBeVisible();
    expect(screen.getByText('42 B')).toBeVisible();
    expect(container.querySelector('.ai-produced-files')).toHaveClass('min-h-6', 'items-center');
    expect(container.querySelector('.ai-produced-files-label')).toHaveClass('gap-1');
    expect(container.querySelector('.ai-produced-files-label > span')).toHaveClass('size-4', 'items-center', 'justify-center');
    expect(getComputedStyle(container.querySelector('.ai-produced-files-label svg')!).translate).toBe('0 -1px');
    await user.click(screen.getByRole('button', { name: 'Open artifact Deployment report' }));
    expect(openArtifact).toHaveBeenCalledWith(artifact);
  });

  it('aligns approval icons and labels with tool rows', () => {
    const tool = toolNode({ key: 'tool:alignment', state: 'succeeded' });
    const approval: AiConversationNodeOf<'approvalMarker'> = {
      kind: 'approvalMarker', key: 'approval:alignment', sourceKind: 'agent',
      sessionId: 'session-fixture', turnId: 'turn-1', stepId: 'step-1',
      firstSeq: 2, lastSeq: 2, timestamp: '2026-09-03T00:00:00.000Z',
      approvalId: 'approval-1', requestId: 'request-1', callId: tool.callId,
      status: 'approved', risk: 'readOnly', prompt: null, reason: null,
      expiresAtUnixMs: null,
    };
    const { container } = render(<AiConversationNodeList nodes={[tool, approval]} />);
    const toolRow = container.querySelector<HTMLElement>('.ai-tool-row')!;
    const approvalRow = container.querySelector<HTMLElement>('.ai-transcript-notice[data-variant="approval"]')!;

    expect(approvalRow).toHaveTextContent('Approved');
    expect(approvalRow).toHaveClass('flex', 'h-6', 'items-center');
    expect(approvalRow.querySelector('.ai-disclosure-leading')).toHaveClass('mr-1', 'size-4');
    expect(approvalRow.querySelector('.ai-disclosure-title')).toHaveClass('shrink-0');
    expect(getComputedStyle(approvalRow).lineHeight).toBe(getComputedStyle(toolRow.querySelector('.ai-disclosure-title')!).lineHeight);
    expect(getComputedStyle(approvalRow.querySelector('svg')!).translate).toBe('0 -1px');
  });

  it('renders only real tail metrics and keeps long generic payloads bounded at narrow widths', async () => {
    const user = userEvent.setup();
    const longValue = `/very-long-segment-${'x'.repeat(80)}`.repeat(20);
    const generic = toolNode({
      key: 'tool:narrow',
      callId: 'call-narrow',
      name: 'vendor.future_capability',
      nativeName: null,
      summary: 'Unknown long payload',
      state: 'succeeded',
      input: { path: longValue },
      output: { value: longValue },
    });
    const projectedTail = projectAgentChatNodes(agentSessionEventFixture)
      .find((node): node is AiConversationNodeOf<'turnTail'> => node.kind === 'turnTail');
    expect(projectedTail).toBeDefined();
    if (!projectedTail) return;
    const stats: AiConversationNodeOf<'turnTail'> = {
      ...projectedTail,
      stats: {
        ...projectedTail.stats,
        stepCount: 2,
        modelDurationMs: null,
        toolDurationMs: 220,
        averageTimeToFirstTokenMs: null,
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        tokensPerSecond: null,
        usageComplete: false,
      },
    };
    const { container } = render(
      <div className="ai-panel-shell" style={{ width: 240 }}>
        <AiConversationNodeList nodes={[generic, stats]} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Tool call: Unknown long payload' }));
    const flow = container.querySelector('[data-ai-node-key="tool:narrow"]') as HTMLElement;
    const card = flow.querySelector('.ai-io-card') as HTMLElement;
    const payload = flow.querySelector('.ai-io-text') as HTMLElement;
    expect(flow).toHaveClass('min-w-0');
    expect(card).toHaveClass('max-w-[calc(100%-4px)]', 'overflow-hidden');
    expect(payload).toHaveClass('[overflow-wrap:anywhere]');

    const footer = screen.getByLabelText('Turn statistics');
    expect(within(footer).queryByRole('button', { name: /^Usage/ })).not.toBeInTheDocument();
    await user.click(within(footer).getByRole('button', { name: /^Time / }));
    const details = await screen.findByRole('dialog', { name: 'Turn timing and speed' });
    expect(details.querySelector('[data-stat="steps"]')).toHaveTextContent('2');
    expect(details.querySelector('[data-stat="tools"]')).toHaveTextContent('0.2s');
    for (const missing of ['model', 'ttft', 'rate', 'tokens']) {
      expect(details.querySelector(`[data-stat="${missing}"]`)).not.toBeInTheDocument();
    }
    const statsRow = footer.querySelector('.ai-turn-stats') as HTMLElement;
    expect(statsRow).toHaveClass('flex', 'flex-wrap', 'overflow-visible');
    await waitFor(() => expect(payload).toHaveTextContent('/very-long-segment'));
  });
});
