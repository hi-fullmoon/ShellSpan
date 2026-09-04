import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiPanel } from '@/components/ai/ai-panel';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ locale: 'en-US', ready: true, setLocale: vi.fn(), t: (key: string) => key }),
}));

const initialAiState = useAiPanelStore.getState();
const initialAiSettingsState = useAiSettingsStore.getState();
const initialTerminalState = useTerminalStore.getState();

let nextAnimationFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 479px)' && width <= 479,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function flushAnimationFrames(): void {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  setViewport(1_200);
  nextAnimationFrameId = 1;
  animationFrames = new Map();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: number) => animationFrames.delete(id),
  });
  useAiPanelStore.setState(initialAiState, true);
  useAiSettingsStore.setState(initialAiSettingsState, true);
  useTerminalStore.setState(initialTerminalState, true);
  useAppStore.setState({ activeSection: 'workbench' });
  useAiPanelStore.setState({ panelOpenBySection: { workbench: true, terminal: false } });
});

afterEach(() => {
  cleanup();
  animationFrames.clear();
});

describe('AI panel production path and immutable shell', () => {
  it('renders the real V2 workspace by default with no content-selection seam', () => {
    render(<div data-testid="outside-ai-scope"><AiPanel /></div>);

    const panel = screen.getByRole('complementary', { name: 'ai.workbench.title' });
    const workspace = panel.querySelector('[data-slot="ai-workspace-root"]');
    expect(panel).toHaveClass('ai-panel-shell');
    expect(getComputedStyle(panel).maxWidth).toBe('100%');
    expect(getComputedStyle(panel).getPropertyValue('--dsw-alias-bg-base').trim())
      .toBe('rgb(255,255,255)');
    expect(getComputedStyle(screen.getByTestId('outside-ai-scope'))
      .getPropertyValue('--dsw-alias-bg-base').trim()).toBe('');
    expect(workspace).toHaveAttribute('data-phase', 'hero');
    expect(workspace).toHaveClass('ai-workspace-root');
    expect(getComputedStyle(workspace as Element).overflowX).toBe('hidden');
    expect(panel.querySelector('[data-slot="ai-empty-hero"]')).toHaveClass('ai-empty-hero');
    expect(panel.querySelector('[data-slot="empty-state-title"]')).toHaveTextContent('ai.workbench.emptyTitle');
    const header = panel.querySelector('[data-slot="ai-workspace-header"]');
    expect(getComputedStyle(header as Element).height).toBe('calc(var(--spacing) * 10)');
    expect(getComputedStyle(header as Element).alignItems).toBe('center');
    expect(getComputedStyle(header as Element).paddingBlockStart).toMatch(/^0(?:px)?$/);
    expect(getComputedStyle(header as Element).paddingBlockEnd).toMatch(/^0(?:px)?$/);
    expect(within(panel).getByRole('textbox'))
      .toHaveAttribute('placeholder', 'ai.workspace.composerPlaceholder');
    expect(panel.querySelector('[data-slot="panel-empty-state"]')).toBeNull();
  });

  it.each([320, 400, 560, 720])('restores a persisted %d px desktop width', (width) => {
    window.localStorage.setItem('shellspan.aiPanelWidth', String(width));
    render(<div><AiPanel /></div>);

    const panel = screen.getByRole('complementary', { name: 'ai.workbench.title' });
    expect(panel).toHaveStyle({ width: `${width}px` });
    expect(screen.getByRole('separator', { name: 'ai.resize' })).toHaveAttribute('aria-valuenow', String(width));
  });

  it('resizes through pointer capture and requestAnimationFrame', () => {
    window.localStorage.setItem('shellspan.aiPanelWidth', '400');
    render(<div><AiPanel /></div>);
    const handle = screen.getByRole('separator', { name: 'ai.resize' });
    expect(handle).toHaveClass('ai-panel-resize-handle');
    expect(handle).toBeEmptyDOMElement();
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 420 });
    act(flushAnimationFrames);
    expect(screen.getByRole('complementary', { name: 'ai.workbench.title' })).toHaveStyle({ width: '480px' });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 420 });
    expect(handle).not.toHaveAttribute('data-resizing');
  });

  it('resizes by the 24 px keyboard contract', () => {
    window.localStorage.setItem('shellspan.aiPanelWidth', '400');
    render(<div><AiPanel /></div>);
    const handle = screen.getByRole('separator', { name: 'ai.resize' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '424');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
  });

  it('keeps the desktop aside and compact Drawer structures', () => {
    const { unmount } = render(<div><AiPanel /></div>);
    expect(screen.getByRole('complementary', { name: 'ai.workbench.title' }))
      .toHaveAttribute('data-ai-scope', 'workbench');
    expect(screen.getByRole('separator', { name: 'ai.resize' })).toBeVisible();
    unmount();

    setViewport(420);
    render(<div><AiPanel /></div>);
    const drawer = document.body.querySelector<HTMLElement>('[data-slot="drawer-content"]');
    const panel = screen.getByRole('complementary', { name: 'ai.workbench.title' });
    expect(drawer).toContainElement(panel);
    expect(panel).toHaveStyle({ width: '100%' });
    expect(panel).toHaveAttribute('data-compact');
    expect(screen.queryByRole('separator', { name: 'ai.resize' })).toBeNull();
    expect(drawer?.querySelector('[data-slot="drawer-title"]')).toHaveTextContent('ai.workbench.title');
  });
});
