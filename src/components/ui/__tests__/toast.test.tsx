import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../sonner';
import { useToastStore } from '@/stores/toastStore';

describe('Toaster', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the sonner toaster container', () => {
    render(<Toaster />);
    expect(
      screen.getByRole('region', { name: 'Notifications alt+T' }),
    ).toBeInTheDocument();
  });

  it('top-aligns the icon for multiline toast content', async () => {
    useToastStore.getState().addToast('First line\nSecond line', 'error', 3000);
    render(<Toaster />);

    await waitFor(() => {
      expect(document.querySelector('[data-icon]')).toHaveClass(
        'mt-[3px]!',
        'self-start!',
      );
    });
  });

  it('exposes toast store add/remove API', () => {
    const id = useToastStore.getState().addToast('Test toast', 'info', 3000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe('Test toast');
    expect(useToastStore.getState().toasts[0].variant).toBe('info');

    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('store supports success variant', () => {
    useToastStore.getState().addToast('Success!', 'success', 2000);
    expect(useToastStore.getState().toasts[0].variant).toBe('success');
  });

  it('store supports error variant', () => {
    useToastStore.getState().addToast('Error!', 'error', 2000);
    expect(useToastStore.getState().toasts[0].variant).toBe('error');
  });

  it('store manages multiple toasts', () => {
    const store = useToastStore.getState();
    store.addToast('A', 'info', 1000);
    store.addToast('B', 'success', 2000);
    store.addToast('C', 'error', 3000);

    expect(useToastStore.getState().toasts).toHaveLength(3);

    const [first] = useToastStore.getState().toasts;
    useToastStore.getState().removeToast(first.id);
    expect(useToastStore.getState().toasts).toHaveLength(2);
    expect(useToastStore.getState().toasts[0].message).toBe('B');
    expect(useToastStore.getState().toasts[1].message).toBe('C');
  });

  it('generates unique ids for each toast', () => {
    const id1 = useToastStore.getState().addToast('One', 'info', 1000);
    const id2 = useToastStore.getState().addToast('Two', 'info', 1000);
    expect(id1).not.toBe(id2);
  });
});
