import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../sonner';
import { useToastStore } from '@/stores/toastStore';

describe('Toaster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses auto-dismiss while hovered and resumes with the remaining time', () => {
    useToastStore.getState().addToast('Saved', 'success', 1000);
    render(<Toaster />);
    const toast = screen.getByRole('status');

    act(() => vi.advanceTimersByTime(600));
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(399));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('collapses more than three toasts and expands the stack on hover', () => {
    const store = useToastStore.getState();
    store.addToast('First', 'info', 10_000);
    store.addToast('Second', 'success', 10_000);
    store.addToast('Third', 'error', 10_000);
    store.addToast('Fourth', 'info', 10_000);
    render(<Toaster />);

    const stack = screen.getByTestId('toast-stack');
    expect(stack).toHaveAttribute('data-collapsed', 'true');
    expect(stack).toHaveClass('fixed');
    expect(stack).not.toHaveClass('relative');
    expect(
      stack.querySelectorAll('[data-toast-hidden="true"]'),
    ).toHaveLength(1);

    fireEvent.mouseEnter(stack);
    expect(stack).toHaveAttribute('data-collapsed', 'false');
    expect(
      stack.querySelectorAll('[data-toast-hidden="true"]'),
    ).toHaveLength(0);
  });

  it('resets the group pause state after the last toast is dismissed', () => {
    useToastStore.getState().addToast('First', 'info', 1000);
    render(<Toaster />);

    const stack = screen.getByTestId('toast-stack');
    fireEvent.mouseEnter(stack);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('First')).not.toBeInTheDocument();

    act(() => {
      useToastStore.getState().addToast('Second', 'info', 1000);
    });
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('pauses while focus is inside the toast', () => {
    useToastStore.getState().addToast('Keyboard toast', 'info', 1000);
    render(<Toaster />);

    const closeButton = screen.getByRole('button', { name: 'Close' });
    fireEvent.focus(closeButton);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('Keyboard toast')).toBeInTheDocument();

    fireEvent.blur(closeButton);
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('Keyboard toast')).not.toBeInTheDocument();
  });

  it('keeps covered toasts out of the focus order and expands on focus', () => {
    const store = useToastStore.getState();
    store.addToast('First', 'info', 10_000);
    store.addToast('Second', 'info', 10_000);
    store.addToast('Third', 'info', 10_000);
    store.addToast('Fourth', 'info', 10_000);
    render(<Toaster />);

    const stack = screen.getByTestId('toast-stack');
    expect(stack.querySelectorAll('[inert]')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);

    fireEvent.focus(screen.getByRole('button', { name: 'Close' }));
    expect(stack).toHaveAttribute('data-collapsed', 'false');
    expect(stack.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('uses alert semantics for error toasts', () => {
    useToastStore.getState().addToast('Connection failed', 'error', 1000);
    render(<Toaster />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveAttribute('aria-atomic', 'true');
  });
});
