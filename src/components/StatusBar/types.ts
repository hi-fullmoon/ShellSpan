import type { ReactNode } from 'react';
import type { OperationItem, OperationStatus, OperationType } from '../../stores/operationStore';

export type StatusTone = 'active' | 'success' | 'error' | 'neutral';

export interface StatusBlockProps {
  icon: ReactNode;
  progress: number;
  tone: StatusTone;
  children?: ReactNode;
  className?: string;
  size?: 'sm' | 'lg';
}

export interface TaskBlockData {
  operation: OperationItem;
  onCancel: () => void;
  onRemove: () => void;
}

export interface StatusBlockTooltipData {
  title: string;
  subtitle?: string;
  detail?: string;
  errorMessage?: string;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

export interface ProgressBarProps {
  progress: number;
  tone: StatusTone;
  className?: string;
}

export interface TaskRowProps {
  operation: OperationItem;
  onCancel: () => void;
  onRemove: () => void;
  className?: string;
}
