import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountNativeManualView } from './native-terminal-manual-view';

describe('native manual host commitment', () => {
  it('returns connected terminal and shared button elements for immediate registry attachment', () => {
    const container = document.createElement('div'); document.body.append(container);
    let view: ReturnType<typeof mountNativeManualView> | undefined;
    act(() => { view = mountNativeManualView(container, 'zsh', 'printf test'); });
    expect(view?.host.isConnected).toBe(true);
    expect(view?.button.isConnected).toBe(true);
    expect(view?.button).toHaveAttribute('data-slot', 'button');
    expect(view?.button).toHaveClass('h-8');
    expect(view?.host).toHaveClass('min-h-0', 'flex-1');
    act(() => view?.root.unmount()); container.remove();
  });
});
