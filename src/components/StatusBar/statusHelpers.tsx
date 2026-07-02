import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { UploadIcon, DownloadIcon, TrashIcon, FileIcon } from '../Icons';
import type { OperationStatus, OperationType } from '../../stores/operationStore';
import type { StatusTone } from './types';

export function operationTone(status: OperationStatus): StatusTone {
  switch (status) {
    case 'running':
    case 'cancelling':
      return 'active';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'neutral';
  }
}

export function operationIcon(type: OperationType): ReactNode {
  switch (type) {
    case 'upload':
      return <UploadIcon className="rotate-180" />;
    case 'download':
      return <DownloadIcon />;
    case 'delete':
      return <TrashIcon />;
    case 'open-with-default':
      return <FileIcon />;
  }
}

export function operationTypeLabel(type: OperationType): string {
  switch (type) {
    case 'upload':
      return t('operationStatus.type.upload');
    case 'download':
      return t('operationStatus.type.download');
    case 'delete':
      return t('operationStatus.type.delete');
    case 'open-with-default':
      return t('operationStatus.type.openWithDefault');
  }
}

export function operationStatusText(status: OperationStatus): string {
  switch (status) {
    case 'running':
      return t('operationStatus.status.running');
    case 'cancelling':
      return t('operationStatus.status.cancelling');
    case 'completed':
      return t('operationStatus.status.completed');
    case 'failed':
      return t('operationStatus.status.failed');
    case 'cancelled':
      return t('operationStatus.status.cancelled');
  }
}
