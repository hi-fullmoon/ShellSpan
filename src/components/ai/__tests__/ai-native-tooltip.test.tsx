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
});
