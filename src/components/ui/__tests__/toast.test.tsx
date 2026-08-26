import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('places the notification stack below the center of the title bar', async () => {
    useToastStore.getState().addToast('Positioned toast', 'info', 3000);
    render(<Toaster />);

    const toaster = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(toaster).toHaveAttribute('data-x-position', 'center');
    expect(toaster).toHaveAttribute('data-y-position', 'top');
    expect(toaster.style.getPropertyValue('--offset-top')).toBe('52px');
    expect(toaster.style.getPropertyValue('--mobile-offset-left')).toBe('12px');
    expect(toaster.style.getPropertyValue('--mobile-offset-right')).toBe('12px');
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

  it('uses a compact content-responsive width', async () => {
    const id = useToastStore.getState().addToast('Saved', 'success', 3000);
    render(<Toaster />);

    expect(await screen.findByTestId(id)).toHaveClass(
      'w-fit!',
      'min-w-48!',
      'max-w-[var(--width)]!',
    );
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

  it('dismisses the toast on double-click', async () => {
    useToastStore.getState().addToast('Double-click to dismiss', 'info', 3000);
    render(<Toaster />);

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).toBeInTheDocument();
    });

    fireEvent.doubleClick(document.querySelector('[data-sonner-toast]')!);

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });

  it('dismisses the selected toast from an expanded stack', async () => {
    const firstId = useToastStore.getState().addToast('First toast', 'info', 3000);
    const secondId = useToastStore.getState().addToast('Second toast', 'success', 3000);
    render(<Toaster />);

    const firstToast = await screen.findByTestId(firstId);
    fireEvent.doubleClick(firstToast);

    await waitFor(() => {
      expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
        secondId,
      ]);
    });
  });

  it('does not dismiss when double-clicking outside a toast', async () => {
    useToastStore.getState().addToast('Keep me', 'info', 3000);
    render(<Toaster />);

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).toBeInTheDocument();
    });

    fireEvent.doubleClick(document.querySelector('[data-sonner-toaster]')!);

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('generates unique ids for each toast', () => {
    const id1 = useToastStore.getState().addToast('One', 'info', 1000);
    const id2 = useToastStore.getState().addToast('Two', 'info', 1000);
    expect(id1).not.toBe(id2);
  });
});
