import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSessionHeader } from '@/components/ai/workspace/ai-session-header';
import { AiSubagentCatalog } from '@/components/ai/workspace/ai-subagent-catalog';
import { AiRouteHeader } from '@/components/ai/workspace/ai-route-header';
import { AiSessionBrowser } from '@/components/ai/workspace/ai-session-browser';
import { AiArtifactDetails } from '@/components/ai/workspace/ai-artifact-details';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('AiSessionHeader', () => {
  it('reveals the full connection context on keyboard focus', async () => {
    const user = userEvent.setup();
    const context = 'Agent · root@175.178.66.45:22 · Connected';
    const { container } = render(<AiSessionHeader title="查看for you部署位置" context={context} status="idle" />);
    expect(container.querySelector('.ai-session-context')).toHaveClass('w-fit', 'max-w-full', 'truncate');
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(context);
  });
  it('uses compact action buttons in new -> history -> export -> close order while preserving callbacks', async () => {
    const user = userEvent.setup();
    const onHistory = vi.fn();
    const onNewSession = vi.fn();
    const onExportMarkdown = vi.fn();
    const onClose = vi.fn();
    render(
      <AiSessionHeader
        title="/docker-diagnosis"
        context="Terminal"
        status="failed"
        onHistory={onHistory}
        onNewSession={onNewSession}
        onExportMarkdown={onExportMarkdown}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('heading', { name: '/docker-diagnosis' })).toBeVisible();
    expect(screen.getByText('Terminal')).toBeVisible();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'New conversation',
      'Conversation history',
      'Export as Markdown',
      'Close AI assistant',
    ]);
    for (const button of buttons) {
      expect(button).toHaveClass('size-7', 'rounded-md', '[&_svg]:size-4');
      expect(button).not.toHaveClass('rounded-full');
      expect(button).toHaveAccessibleName();
      await user.click(button);
    }
    expect(onHistory).toHaveBeenCalledOnce();
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onExportMarkdown).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('softens shell separators to match the surrounding chrome borders', () => {
    const { container } = render(
      <AiSessionHeader
        title="/docker-diagnosis"
        context="Terminal"
        status="failed"
        onHistory={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const sessionHeader = container.querySelector<HTMLElement>('.ai-session-header')!;
    expect(sessionHeader).toHaveClass('border-b', 'border-app-border/50');
    expect(sessionHeader).not.toHaveClass('border-border');

    const { container: routeContainer } = render(
      <AiRouteHeader title="History" description="Session history" onBack={vi.fn()} />,
    );
    const routeHeader = routeContainer.querySelector<HTMLElement>('.ai-route-header')!;
    expect(routeHeader).toHaveClass('border-b', 'border-app-border/50');
    expect(routeHeader).not.toHaveClass('border-border');
  });

  it.each(['history', 'artifact details'] as const)(
    'uses the same buttons in %s and preserves navigation',
    async (page) => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      const onClose = vi.fn();
      const onNew = vi.fn();
      const onRefresh = vi.fn();
      const { container } = render(page === 'history' ? (
        <AiSessionBrowser
          sessions={[]} loading={false} error={null} archivingId={null} canStartAgent
          onBack={onBack} onClose={onClose} onNew={onNew} onRefresh={onRefresh}
          onOpen={vi.fn()} onArchive={vi.fn()}
        />
      ) : (
        <AiArtifactDetails sessionId="fixture" node={null} load={vi.fn()} onBack={onBack} onClose={onClose} />
      ));
      const header = container.querySelector<HTMLElement>('.ai-route-header')!;
      const headerButtons = within(header).getAllByRole('button');
      expect(headerButtons).toHaveLength(page === 'history' ? 3 : 2);
      for (const button of headerButtons) {
        expect(button).toHaveClass('size-7', 'rounded-md', '[&_svg]:size-4');
        expect(button).not.toHaveClass('rounded-full');
        expect(button).toHaveAccessibleName();
        await user.click(button);
      }
      expect(onBack).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      if (page === 'history') {
        expect(onNew).toHaveBeenCalledOnce();
        const toolbar = container.querySelector<HTMLElement>('.ai-session-browser-toolbar')!;
        const toolbarButtons = within(toolbar).getAllByRole('button');
        expect(toolbarButtons).toHaveLength(2);
        for (const button of toolbarButtons) {
          expect(button).toHaveClass('size-7', 'rounded-md', '[&_svg]:size-4');
          expect(button).not.toHaveClass('rounded-full');
        }
        await user.click(within(toolbar).getByRole('button', { name: 'Refresh' }));
        expect(onRefresh).toHaveBeenCalledOnce();
      }
    },
  );

  it('uses a shorter filter button in the compact session browser', () => {
    render(
      <AiSessionBrowser
        compact
        sessions={[]}
        loading={false}
        error={null}
        archivingId={null}
        canStartAgent
        onBack={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onRefresh={vi.fn()}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Filter sessions' })).toHaveClass('h-7');
  });

  it('identifies the current login above terminal history', () => {
    render(
      <AiSessionBrowser compact scopeLabel="root@175.178.66.45:22"
        sessions={[]} loading={false} error={null} archivingId={null}
        onBack={vi.fn()} onNew={vi.fn()} onOpen={vi.fn()} onArchive={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Current login: root@175.178.66.45:22'))
      .toHaveTextContent('root@175.178.66.45:22');
  });

  it('keeps subagent Sessions out of ordinary history', () => {
    const parent: AiSessionSummary = {
      id: 'parent',
      kind: 'agent',
      title: 'Parent task',
      updatedAt: '2026-09-18T00:00:00.000Z',
      status: 'running',
      scopeKey: 'workbench-ai',
      archived: false,
    };
    const child: AiSessionSummary = {
      ...parent,
      id: 'child',
      title: 'Inspect implementation',
      parentSessionId: parent.id,
      subagent: {
        descriptorId: 'descriptor-child',
        role: 'explorer',
        continuable: false,
        depth: 1,
      },
    };
    render(
      <AiSessionBrowser
        sessions={[parent, child]}
        loading={false}
        error={null}
        archivingId={null}
        onBack={vi.fn()}
        onNew={vi.fn()}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByText('Parent task')).toBeVisible();
    expect(screen.queryByText('Inspect implementation')).toBeNull();

    cleanup();
    render(
      <AiSessionBrowser
        sessions={[child]}
        loading={false}
        error={null}
        archivingId={null}
        onBack={vi.fn()}
        onNew={vi.fn()}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByText('Inspect implementation')).toBeVisible();
  });

  it('switches to subagent navigation mode with back action, role badge, breadcrumb tooltip, and switcher', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onHistory = vi.fn();
    const onNewSession = vi.fn();
    const onClose = vi.fn();
    const root: AiSessionSummary = {
      id: 'root',
      kind: 'agent',
      title: 'Main task',
      updatedAt: '2026-11-20T00:00:00.000Z',
      status: 'running',
      scopeKey: 'workbench-ai',
      archived: false,
    };
    const child: AiSessionSummary = {
      ...root,
      id: 'child',
      title: 'Inspect service logs',
      parentSessionId: root.id,
      subagent: {
        descriptorId: 'd-child',
        role: 'explorer',
        continuable: true,
        depth: 1,
      },
    };
    const switcher = (
      <AiSubagentCatalog
        root={root}
        current={child}
        entries={[{
          summary: child,
          parentSessionId: root.id,
          role: 'explorer',
          continuable: true,
          status: 'running',
          depth: 1,
        }]}
        onOpen={vi.fn()}
      />
    );
    const { container, rerender } = render(
      <AiSessionHeader
        title={child.title}
        context="Agent"
        status="running"
        onHistory={onHistory}
        onNewSession={onNewSession}
        onClose={onClose}
        subagentNav={{
          roleLabel: 'Explorer',
          subtitle: 'Main task · Continuable · Running',
          subtitleTooltip: 'Main task / Inspect service logs · Continuable · Running',
          backLabel: 'Back to main session: Main task',
          onBack,
          switcher,
          hideSessionChrome: true,
        }}
      />,
    );

    const header = container.querySelector<HTMLElement>('.ai-session-header')!;
    expect(header).toHaveAttribute('data-subagent-view', 'true');
    expect(header).toHaveClass('h-10', 'min-h-10', 'border-b', 'border-app-border/50');
    expect(header.querySelector('.ai-session-heading .ai-session-status-dot')).toBeNull();
    const roleBadge = within(header).getByText('Explorer');
    const heading = within(header).getByRole('heading', { name: 'Inspect service logs' });
    expect(roleBadge).toBeVisible();
    expect(roleBadge).toHaveAttribute('data-variant', 'outline');
    expect(heading).toBeVisible();
    expect(Boolean(heading.compareDocumentPosition(roleBadge) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Conversation history' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();

    const backButton = screen.getByRole('button', { name: 'Back to main session: Main task' });
    await user.click(backButton);
    expect(onBack).toHaveBeenCalledOnce();

    await user.tab();
    await user.tab();
    const context = container.querySelector<HTMLElement>('.ai-session-context')!;
    context.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Main task / Inspect service logs · Continuable · Running',
    );

    rerender(
      <AiSessionHeader
        title={child.title}
        context="Agent"
        status="running"
        onHistory={onHistory}
        onNewSession={onNewSession}
        onClose={onClose}
        subagentNav={{
          roleLabel: 'Explorer',
          subtitle: 'Continuable · Running',
          subtitleTooltip: 'Inspect service logs · Continuable · Running',
          switcher,
          hideSessionChrome: false,
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Conversation history' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });

  it('places sessionActions before persistent chrome icons while keeping extraActions and close anchored right', () => {
    const { container } = render(
      <AiSessionHeader
        title="Deploy API"
        context="Terminal"
        status="idle"
        sessionActions={<button type="button" aria-label="Snapshots (2)">2</button>}
        extraActions={<button type="button" aria-label="Expand terminal" />}
        onNewSession={vi.fn()}
        onHistory={vi.fn()}
        onExportMarkdown={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Snapshots (2)',
      'New conversation',
      'Conversation history',
      'Export as Markdown',
      'Expand terminal',
      'Close AI assistant',
    ]);
    const leadingGroup = container.querySelector('[data-slot="ai-session-leading-actions"]');
    expect(leadingGroup).toHaveClass('empty:hidden');
    expect(leadingGroup?.className).toContain('after:w-px');
  });
});
