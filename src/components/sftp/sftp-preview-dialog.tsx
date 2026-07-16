import React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import { formatSize } from '@/lib/sftp-utils';
import type { ReadRemoteFileResponse } from '@/types';
import { FileWarningIcon } from 'lucide-react';
import {
  SftpDialogBody,
  SftpDialogContent,
  SftpDialogHeader,
} from './sftp-dialog-layout';

export interface SftpPreviewDialogProps {
  content?: ReadRemoteFileResponse;
  open: boolean;
  onClose: () => void;
}

export const SftpPreviewDialog: React.FC<SftpPreviewDialogProps> = ({
  content,
  open,
  onClose,
}) => {
  const { t } = useI18n();

  if (!content) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SftpDialogContent className="max-w-2xl">
        <SftpDialogHeader title={t('sftp.preview.title')} />
        <SftpDialogBody className="gap-3">
          <div className="flex items-center justify-between gap-4 rounded-md border border-app-border bg-app-surface-muted/35 px-3 py-2 text-xs text-app-text-soft">
            <span className="truncate font-medium text-app-text" title={content.name}>
              {content.name}
            </span>
            <span className="shrink-0 font-mono">{formatSize(Number(content.size))}</span>
          </div>
          {!content.isText ? (
            <div className="flex items-center gap-3 rounded-lg border border-app-warning/25 bg-app-warning/5 p-4 text-sm text-app-text-soft">
              <FileWarningIcon className="size-5 shrink-0 text-app-warning" aria-hidden="true" />
              <span>{t('sftp.preview.binaryWarning')}</span>
            </div>
          ) : (
            <textarea
              readOnly
              value={content.content}
              className="h-[60vh] w-full resize-none rounded-lg border border-app-border bg-app-surface-muted/50 p-4 font-mono text-xs leading-5 text-app-text outline-none focus-visible:ring-1 focus-visible:ring-app-primary"
            />
          )}
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
