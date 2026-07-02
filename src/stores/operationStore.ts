import { create } from 'zustand';

export type OperationType = 'upload' | 'download' | 'delete' | 'open-with-default';

export type OperationStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface OperationItem {
  id: string;
  type: OperationType;
  title: string;
  status: OperationStatus;
  progress: number;
  totalText?: string;
  canCancel: boolean;
  errorMessage?: string;
  createdAt: number;
  cancel?: () => Promise<void>;
}

export interface OperationUpdate {
  progress?: number;
  totalText?: string;
}

export interface OperationStartInput {
  id?: string;
  type: OperationType;
  title: string;
  status?: OperationStatus;
  progress?: number;
  totalText?: string;
  canCancel?: boolean;
  cancel?: () => Promise<void>;
}

interface OperationStoreState {
  operations: OperationItem[];
  expanded: boolean;
  startOperation: (input: OperationStartInput) => OperationItem;
  updateOperation: (id: string, update: OperationUpdate) => void;
  setOperationStatus: (id: string, status: OperationStatus, errorMessage?: string) => void;
  setCancelling: (id: string) => void;
  removeOperation: (id: string) => void;
  clearCompleted: () => void;
  setExpanded: (expanded: boolean) => void;
}

export function createOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampProgress(value?: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

export const useOperationStore = create<OperationStoreState>((set) => ({
  operations: [],
  expanded: false,

  startOperation: (input) => {
    const item: OperationItem = {
      id: input.id ?? createOperationId(),
      type: input.type,
      title: input.title,
      status: input.status ?? 'running',
      progress: clampProgress(input.progress),
      totalText: input.totalText,
      canCancel: input.canCancel ?? true,
      cancel: input.cancel,
      createdAt: Date.now(),
    };

    set((state) => ({
      operations: [...state.operations, item],
    }));

    return item;
  },

  updateOperation: (id, update) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.id === id && op.status === 'running'
          ? {
              ...op,
              progress: update.progress !== undefined ? clampProgress(update.progress) : op.progress,
              totalText: update.totalText !== undefined ? update.totalText : op.totalText,
            }
          : op,
      ),
    })),

  setOperationStatus: (id, status, errorMessage) =>
    set((state) => ({
      operations: state.operations.map((op) =>
        op.id === id
          ? {
              ...op,
              status,
              errorMessage,
              progress: status === 'completed' ? 100 : op.progress,
            }
          : op,
      ),
    })),

  setCancelling: (id) =>
    set((state) => ({
      operations: state.operations.map((op) => (op.id === id ? { ...op, status: 'cancelling' as const } : op)),
    })),

  removeOperation: (id) =>
    set((state) => ({
      operations: state.operations.filter((op) => op.id !== id),
    })),

  clearCompleted: () =>
    set((state) => ({
      operations: state.operations.filter((op) => op.status === 'running' || op.status === 'cancelling'),
    })),

  setExpanded: (expanded) => set({ expanded }),
}));

export function selectActiveOperations(state: OperationStoreState): OperationItem[] {
  return state.operations.filter((op) => op.status === 'running' || op.status === 'cancelling');
}

export function selectCompletedOperations(state: OperationStoreState): OperationItem[] {
  return state.operations.filter((op) => op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled');
}

export function selectHasVisibleOperations(state: OperationStoreState): boolean {
  return state.operations.length > 0;
}

export function selectOverallProgress(operations: OperationItem[]): number {
  const active = operations.filter((op) => op.status === 'running' || op.status === 'cancelling');
  if (active.length === 0) {
    return 0;
  }

  const sum = active.reduce((acc, op) => acc + op.progress, 0);
  return Math.round(sum / active.length);
}
