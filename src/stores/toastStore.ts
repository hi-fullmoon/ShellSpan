import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (message: string, variant: ToastVariant, duration?: number) => string;
  removeToast: (id: string) => void;
}

const DEFAULT_DURATION = 3000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (message, variant, duration = DEFAULT_DURATION) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, message, variant, duration }],
    }));
    return id;
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  },
}));
