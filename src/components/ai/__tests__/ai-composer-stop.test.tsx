import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

describe('composer single primary action', () => {
  it('switches the same button between stop and send for text and attachments', () => {
    const onStop = () => {};
    const onSubmit = () => {};
    const { container, rerender } = render(<AiComposerSeat phase="active" status="running" onStop={onStop} onSubmit={onSubmit} />);
    const button = screen.getByRole('button', { name: 'Stop this turn' });
    for (const props of [{ draft: 'Continue' }, { hasImages: true }]) {
      rerender(<AiComposerSeat phase="active" status="running" onStop={onStop} onSubmit={onSubmit} {...props} />);
      expect(screen.queryByRole('button', { name: 'Stop this turn' })).toBeNull();
      expect(container.querySelectorAll('.ai-composer-primary')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Queue for next turn' })).toBe(button);
    }
    rerender(<AiComposerSeat phase="active" status="running" onStop={onStop} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBe(button);
  });

  it('stops with two independent Esc presses without submitting or clearing the draft', () => {
    let stops = 0;
    let sends = 0;
    render(<AiComposerSeat phase="active" status="running" defaultDraft="Keep this draft" onStop={() => { stops++; }} onSubmit={() => { sends++; }} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(stops).toBe(0);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(stops).toBe(1);
    expect(sends).toBe(0);
    expect(editor).toHaveTextContent('Keep this draft');
  });

  it.each(['repeat', 'composition', 'otherKey', 'focus', 'outside', 'dialog'] as const)('breaks the stop sequence on %s', kind => {
    let stops = 0;
    render(<AiComposerSeat phase="active" status="running" onStop={() => { stops++; }} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Escape' });
    if (kind === 'repeat') fireEvent.keyDown(editor, { key: 'Escape', repeat: true });
    if (kind === 'composition') fireEvent.compositionStart(editor);
    if (kind === 'otherKey') fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    if (kind === 'focus') fireEvent.focusIn(editor);
    if (kind === 'outside') fireEvent.keyDown(document.body, { key: 'Escape' });
    if (kind === 'dialog') {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.append(dialog);
      fireEvent.keyDown(editor, { key: 'Escape' });
      dialog.remove();
    }
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(stops).toBe(0);
  });
});
