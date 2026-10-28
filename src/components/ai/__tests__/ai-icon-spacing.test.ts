import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiTaskStrip } from '../workspace/ai-task-strip';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { recordedChildFailureView } from '@/test/fixtures/child-recovery-recording';

afterEach(cleanup);

describe('AI inline icon spacing', () => {
  it.each([
    ['ai-mention-panel.tsx', 'h-auto min-h-7 w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-sm leading-5 font-normal'],
    ['ai-context-meter.tsx', 'flex min-w-0 items-center gap-1'],
  ])('%s keeps icon labels centered with the shared gap', (file, classes) => {
    const source = readFileSync(`src/components/ai/workspace/${file}`, 'utf8');
    expect(source).toContain(`className="${classes}"`);
    if (file === 'ai-context-meter.tsx') {
      expect(source).not.toContain('mr-1.5 inline-block size-2 align-baseline');
    }
  });

  it('keeps rendered task icons and labels centered with the shared gap', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    const steps = recordedChildFailureView().snapshot.value.task.plan!.steps;
    render(createElement(AiTaskStrip, { steps }));
    fireEvent.click(screen.getByRole('button', { name: `Toggle ${steps.length} tasks` }));

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(steps.length);
    for (const row of rows) {
      expect(row).toHaveClass('flex', 'min-h-5', 'min-w-0', 'shrink-0', 'items-center', 'gap-1');
      expect(row.querySelector('svg')).not.toBeNull();
    }
    for (const step of steps) expect(screen.getByText(step.title)).toBeVisible();
  });
});
