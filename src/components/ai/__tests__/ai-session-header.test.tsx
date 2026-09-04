import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSessionHeader } from '@/components/ai/workspace/ai-session-header';
import { AiSessionBrowser } from '@/components/ai/workspace/ai-session-browser';
import { AiToolDetails } from '@/components/ai/workspace/ai-tool-details';
import { AiArtifactDetails } from '@/components/ai/workspace/ai-artifact-details';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('AiSessionHeader', () => {
  it('uses compact action buttons while preserving their labels and callbacks', async () => {
    const user = userEvent.setup();
    const onHistory = vi.fn();
    const onNewSession = vi.fn();
    const onClose = vi.fn();
    render(
      <AiSessionHeader
        title="/docker-diagnosis"
        context="Terminal"
        status="failed"
        onHistory={onHistory}
        onNewSession={onNewSession}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('heading', { name: '/docker-diagnosis' })).toBeVisible();
    expect(screen.getByText('Terminal')).toBeVisible();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button).toHaveClass('size-7', 'rounded-md', '[&_svg]:size-4');
      expect(button).not.toHaveClass('rounded-full');
      expect(button).toHaveAccessibleName();
      await user.click(button);
    }
    expect(onHistory).toHaveBeenCalledOnce();
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['history', 'tool details', 'artifact details'] as const)(
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
      ) : page === 'tool details' ? (
        <AiToolDetails node={null} onBack={onBack} onClose={onClose} />
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
});
