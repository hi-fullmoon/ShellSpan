import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { AiComposerAddMenu } from '../workspace/ai-composer-add-menu';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('AI panel native tooltip removal', () => {
  it.each([false, true])('keeps the file instructions accessible without native tooltips (agent: %s)', async (agent) => {
    const user = userEvent.setup();
    render(<AiComposerAddMenu disabled={false} agent={agent} anchor={createRef<HTMLDivElement>()}
      onAddFile={() => {}} onAddFolder={() => {}} onSkill={() => {}} />);
    await user.click(screen.getByRole('button'));
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]).toHaveAttribute('aria-description', expect.stringContaining('PDF'));
    expect(document.body.querySelector('[title]')).toBeNull();
  });

  it('keeps the disabled execution explanation accessible without a native tooltip', () => {
    render(<AgentExecutionSurfaceSelector disabled surface="direct" />);
    const trigger = screen.getByRole('button');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('aria-description', expect.stringContaining('idle'));
    expect(trigger).not.toHaveAttribute('title');
  });

  it('shows the execution mode on keyboard focus and closes its tooltip when opening the menu', async () => {
    const user = userEvent.setup();
    render(<AgentExecutionSurfaceSelector surface="direct" />);
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Direct');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeVisible();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('keeps disabled compact controls readable without enabling their actions', async () => {
    const user = userEvent.setup();
    let parentClicks = 0;
    let parentKeys = 0;
    render(<div onClick={() => { parentClicks++; }} onKeyDown={() => { parentKeys++; }}><AgentExecutionSurfaceSelector disabled surface="direct" /></div>);
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Direct');
    await user.click(screen.getByRole('button').parentElement!);
    expect(parentClicks).toBe(0);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(parentKeys).toBe(0);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
