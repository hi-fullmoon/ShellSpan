import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiSubagentContext, type AiSubagentContextValue } from '@/components/ai/workspace/ai-subagent-context';
import { AiSubagentToolCard } from '@/components/ai/workspace/ai-subagent-tool-card';
import { AiToolRow } from '@/components/ai/workspace/ai-tool-presentation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import type { AiSubagentLineage } from '@/lib/ai/subagent-lineage';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

function makeSummary(overrides: Partial<AiSessionSummary> = {}): AiSessionSummary {
  return {
    id: 'child-session-1',
    kind: 'agent',
    title: 'Inspect remote terminal',
    updatedAt: '2026-11-20T12:00:00.000Z',
    status: 'completed',
    scopeKey: 'terminal-1',
    archived: false,
    parentSessionId: 'root-session',
    subagent: {
      descriptorId: 'desc-1',
      role: 'operator',
      continuable: true,
      depth: 1,
    },
    ...overrides,
  };
}

function makeLineage(childSummary: AiSessionSummary): AiSubagentLineage {
  const rootSummary = makeSummary({
    id: 'root-session',
    title: 'Root session',
    parentSessionId: undefined,
    subagent: undefined,
  });
  return {
    root: rootSummary,
    current: rootSummary,
    parent: null,
    trail: [rootSummary],
    entries: [
      {
        summary: childSummary,
        parentSessionId: rootSummary.id,
        role: childSummary.subagent?.role ?? 'operator',
        continuable: childSummary.subagent?.continuable ?? true,
        status: childSummary.status,
        depth: 1,
      },
    ],
    currentChildren: [],
    byId: new Map([
      [rootSummary.id, rootSummary],
      [childSummary.id, childSummary],
    ]),
    entryById: new Map(),
  };
}

function makeSubagentNode(
  overrides: Partial<AiConversationNodeOf<'tool'>> = {},
): AiConversationNodeOf<'tool'> {
  return {
    kind: 'tool',
    key: 'tool:subagent-1',
    sourceKind: 'agent',
    sessionId: 'root-session',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 2,
    timestamp: '2026-11-20T12:00:00.000Z',
    callId: 'call-subagent-1',
    name: 'spawn_continuable_agent',
    nativeName: 'spawn_continuable_agent',
    title: 'Agent orchestration',
    summary: 'Completed read-only inspection.',
    state: 'succeeded',
    effect: 'readOnly',
    durationMs: 1200,
    detailRef: { kind: 'agentTool', sessionId: 'root-session', callId: 'call-subagent-1' },
    evidenceRefs: [],
    input: {
      role: 'operator',
      goal: 'Check remote terminal\nLine 2: inspect ports and processes',
      content: 'Follow up with process tree output.',
    },
    output: {
      childSessionId: 'child-session-1',
      status: 'completed',
      plan: [
        { id: 'step-1', title: 'Check working directory', status: 'completed' },
        { id: 'step-2', title: 'List listening ports', status: 'inProgress' },
      ],
    },
    error: null,
    target: null,
    idempotency: null,
    approval: null,
    ...overrides,
  };
}

describe('AiSubagentToolCard', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'navigates directly to the child session on click when openable in %s',
    async (locale) => {
      await initI18n(locale);
      useAppStore.setState({ locale });

      const user = userEvent.setup();
      const childSummary = makeSummary();
      const onOpenSession = vi.fn();
      const node = makeSubagentNode();
      const contextValue: AiSubagentContextValue = {
        lineage: makeLineage(childSummary),
        toolChildSessionIds: new Map([[node.key, childSummary.id]]),
        onOpenSession,
      };

      const { container } = render(
        <AiSubagentContext.Provider value={contextValue}>
          <AiSubagentToolCard node={node} />
        </AiSubagentContext.Provider>,
      );

      const expectedRowTitle = locale === 'zh-CN' ? '执行子代理' : 'Operator subagent';
      const openAria = locale === 'zh-CN'
        ? '进入子代理“Check remote terminal”：执行，已完成'
        : 'Open subagent “Check remote terminal”: Operator, Completed';

      const card = container.querySelector('[data-slot="ai-subagent-card"]') as HTMLElement;
      expect(card).toHaveAttribute('data-openable', 'true');
      expect(card).toHaveAttribute('data-clickable', 'true');
      expect(card.querySelector('.ai-disclosure-title')).toHaveTextContent(expectedRowTitle);
      expect(card.querySelector('.ai-disclosure-summary')).toHaveTextContent('Check remote terminal');

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      const rowTrigger = buttons[0]!;
      expect(rowTrigger).toHaveClass('ai-subagent-row-trigger');
      expect(rowTrigger).toHaveAttribute('aria-label', openAria);
      expect(rowTrigger).not.toHaveAttribute('aria-expanded');
      expect(card.querySelector('.ai-subagent-row-open')).toBeNull();
      expect(card.querySelector('.ai-disclosure-leading > .ai-subagent-row-enter.ai-disclosure-chevron')).toBeInTheDocument();
      expect(rowTrigger.lastElementChild).toHaveClass('ai-tool-meta');
      expect(card.querySelector('.ai-subagent-card-body')).toBeNull();

      await user.click(rowTrigger);
      expect(onOpenSession).toHaveBeenCalledTimes(1);
      expect(onOpenSession).toHaveBeenCalledWith(childSummary);
      expect(card.querySelector('.ai-subagent-card-body')).toBeNull();
    },
  );

  it.each(['en-US', 'zh-CN'] as const)(
    'caps expanded details height with ScrollArea without rendering View details when no child session is openable in %s',
    async (locale) => {
      await initI18n(locale);
      useAppStore.setState({ locale });

      const user = userEvent.setup();
      const node = makeSubagentNode();

      const { container } = render(<AiSubagentToolCard node={node} />);

      const expectedRowTitle = locale === 'zh-CN' ? '执行子代理' : 'Operator subagent';
      const goalLabel = locale === 'zh-CN' ? '任务目标' : 'Task goal';
      const inputLabel = locale === 'zh-CN' ? '补充指令' : 'Follow-up input';
      const planLabel = locale === 'zh-CN' ? '子任务进度' : 'Subtask plan';
      const resultLabel = locale === 'zh-CN' ? '执行结果' : 'Result';
      const inspectLabel = locale === 'zh-CN' ? '查看详情' : 'View details';

      const card = container.querySelector('[data-slot="ai-subagent-card"]') as HTMLElement;
      expect(card).not.toHaveAttribute('data-openable');
      expect(card.querySelector('.ai-disclosure-title')).toHaveTextContent(expectedRowTitle);
      expect(card.querySelector('.ai-disclosure-summary')).toHaveTextContent('Check remote terminal');
      expect(card.querySelector('.ai-subagent-row-enter')).toBeNull();

      const rowTrigger = container.querySelector('.ai-subagent-row-trigger') as HTMLButtonElement;
      expect(rowTrigger.tagName).toBe('BUTTON');
      expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');

      await user.click(rowTrigger);
      expect(rowTrigger).toHaveAttribute('aria-expanded', 'true');

      const body = container.querySelector('.ai-subagent-card-body') as HTMLElement;
      expect(body).toBeVisible();
      expect(body).toHaveClass('flex', 'min-w-0', 'flex-col', 'text-xs');

      const scrollArea = body.querySelector('[data-slot="scroll-area"]') as HTMLElement;
      expect(scrollArea).toBeVisible();
      expect(scrollArea).toHaveClass(
        'ai-subagent-card-scroll',
        'max-h-65',
        'min-h-0',
        'min-w-0',
        'flex-col',
        'overflow-hidden',
      );
      expect(scrollArea).not.toHaveClass('ai-tool-scroll-area');

      const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
      expect(viewport).toHaveClass('h-auto', 'min-h-0', 'flex-1');
      expect(viewport.style.overflowX).toBe('hidden');

      const scrollContent = scrollArea.querySelector('[data-slot="scroll-area-content"]') as HTMLElement;
      expect(scrollContent).toHaveStyle({ minWidth: '0' });
      expect(scrollContent).toHaveClass('flex', 'min-w-0', 'flex-col', 'gap-2', 'px-3', 'pt-2', 'pb-2.5');
      expect(within(scrollContent).getByText(locale === 'zh-CN' ? /可继续/ : /Continuable/)).toBeVisible();
      expect(within(scrollContent).getByText(goalLabel)).toBeVisible();
      expect(within(scrollContent).getByText(inputLabel)).toBeVisible();
      expect(within(scrollContent).getByText(planLabel)).toBeVisible();
      expect(within(scrollContent).getByText(resultLabel)).toBeVisible();

      expect(within(body).queryByText(inspectLabel)).not.toBeInTheDocument();
      expect(within(body).queryByRole('button')).toBeNull();

      await user.click(rowTrigger);
      expect(rowTrigger).toHaveAttribute('aria-expanded', 'false');
    },
  );

  it('uses pb-2.5 inside ScrollAreaContent when there are details only and no actions', async () => {
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });

    const user = userEvent.setup();
    const node = makeSubagentNode({
      output: { status: 'completed' },
    });

    const { container } = render(<AiSubagentToolCard node={node} />);
    await user.click(container.querySelector('.ai-subagent-row-trigger') as HTMLButtonElement);

    const body = container.querySelector('.ai-subagent-card-body') as HTMLElement;
    const scrollArea = body.querySelector('[data-slot="scroll-area"]') as HTMLElement;
    const scrollContent = scrollArea.querySelector('[data-slot="scroll-area-content"]') as HTMLElement;
    expect(scrollContent).toHaveClass('pb-2.5');
    expect(scrollContent).not.toHaveClass('pb-1.5');
    expect(within(body).queryByRole('button')).toBeNull();
  });

  it('renders a non-expandable row when there are no body details', async () => {
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });

    const node = makeSubagentNode({
      summary: '',
      input: {
        role: 'operator',
        goal: 'Single line goal',
      },
      output: { status: 'completed' },
    });

    const { container } = render(<AiSubagentToolCard node={node} />);
    const card = container.querySelector('[data-slot="ai-subagent-card"]') as HTMLElement;
    expect(card).not.toHaveAttribute('data-clickable');
    expect(container.querySelector('.ai-subagent-row-trigger')?.tagName).toBe('DIV');
    expect(container.querySelector('.ai-subagent-card-body')).toBeNull();
    expect(screen.queryByText('View details')).not.toBeInTheDocument();
  });
});

describe('AiToolRow subagent delegation vs read/control routing', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'renders delegation actions as compact subagent rows and inspect/cancel as standard tool rows in %s',
    async (locale) => {
      await initI18n(locale);
      useAppStore.setState({ locale });

      const childSummary = makeSummary({ title: 'Inspect nginx configuration' });
      const contextValue: AiSubagentContextValue = {
        lineage: makeLineage(childSummary),
        toolChildSessionIds: new Map([
          ['tool:spawn', childSummary.id],
          ['tool:input', childSummary.id],
          ['tool:retry', childSummary.id],
          ['tool:inspect', childSummary.id],
          ['tool:cancel', childSummary.id],
        ]),
        onOpenSession: vi.fn(),
      };

      const spawnNode = makeSubagentNode({
        key: 'tool:spawn',
        name: 'spawn_continuable_agent',
        nativeName: 'spawn_continuable_agent',
      });
      const inputNode = makeSubagentNode({
        key: 'tool:input',
        name: 'send_child_input',
        nativeName: 'send_child_input',
        input: { childSessionId: childSummary.id, content: 'Also check TLS expiry' },
        output: { childSessionId: childSummary.id, status: 'completed' },
      });
      const retryNode = makeSubagentNode({
        key: 'tool:retry',
        name: 'retry_child_agent',
        nativeName: 'retry_child_agent',
        input: { childSessionId: childSummary.id },
        output: { childSessionId: childSummary.id, status: 'completed' },
      });
      const inspectNode = makeSubagentNode({
        key: 'tool:inspect',
        name: 'inspect_child_agent',
        nativeName: 'inspect_child_agent',
        state: 'succeeded',
        summary: 'Child child-uuid-raw is Failed',
        input: { childSessionId: 'child-uuid-raw' },
        output: {
          snapshot: {
            status: 'failed',
            header: {
              sessionId: 'child-uuid-raw',
              goal: 'Check upstream nginx status',
              subagent: { role: 'operator' },
            },
          },
        },
      });
      const cancelNode = makeSubagentNode({
        key: 'tool:cancel',
        name: 'cancel_child_agent',
        nativeName: 'cancel_child_agent',
        state: 'succeeded',
        summary: 'Cancelled child tree rooted at child-uuid-raw',
        input: { childSessionId: 'child-uuid-raw' },
        output: { childSessionId: 'child-uuid-raw' },
      });

      const { container } = render(
        <AiSubagentContext.Provider value={contextValue}>
          <AiToolRow node={spawnNode} />
          <AiToolRow node={inputNode} />
          <AiToolRow node={retryNode} />
          <AiToolRow node={inspectNode} />
          <AiToolRow node={cancelNode} />
        </AiSubagentContext.Provider>,
      );

      const delegationCards = container.querySelectorAll<HTMLElement>('[data-slot="ai-subagent-card"]');
      expect(delegationCards).toHaveLength(3);
      expect(delegationCards[0]!.querySelector('.ai-disclosure-title')).toHaveTextContent(
        locale === 'zh-CN' ? '执行子代理' : 'Operator subagent',
      );
      expect(delegationCards[1]!.querySelector('.ai-disclosure-title')).toHaveTextContent(
        locale === 'zh-CN' ? '继续子代理' : 'Continue subagent',
      );
      expect(delegationCards[2]!.querySelector('.ai-disclosure-title')).toHaveTextContent(
        locale === 'zh-CN' ? '重试子代理' : 'Retry subagent',
      );

      const standardRows = container.querySelectorAll<HTMLElement>('.ai-tool-row-root');
      expect(standardRows).toHaveLength(2);

      const [inspectRow, cancelRow] = [standardRows[0]!, standardRows[1]!];
      expect(inspectRow).toHaveAttribute('data-tool-state', 'succeeded');
      expect(inspectRow.querySelector('.ai-state-dot[data-state="failed"]')).toBeNull();
      expect(inspectRow.querySelector('.ai-disclosure-summary')).not.toHaveAttribute('data-error');
      expect(inspectRow.querySelector('.ai-disclosure-title')).toHaveTextContent(
        locale === 'zh-CN' ? '检查子代理' : 'Inspect subagent',
      );
      expect(inspectRow.querySelector('.ai-disclosure-summary')).toHaveTextContent('Inspect nginx configuration');

      expect(cancelRow).toHaveAttribute('data-tool-state', 'succeeded');
      expect(cancelRow.querySelector('.ai-disclosure-title')).toHaveTextContent(
        locale === 'zh-CN' ? '取消子代理' : 'Cancel subagent',
      );
      expect(cancelRow.querySelector('.ai-disclosure-summary')).toHaveTextContent('Inspect nginx configuration');
      expect(container).not.toHaveTextContent('Agent orchestration');
      expect(container).not.toHaveTextContent('child-uuid-raw');
    },
  );
});
