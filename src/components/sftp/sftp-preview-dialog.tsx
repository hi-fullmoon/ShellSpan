import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import { formatSize } from '@/lib/sftp-utils';
import type { ReadRemoteFileResponse } from '@/types';

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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('sftp.preview.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4 text-xs text-app-text-soft">
            <span className="truncate font-medium text-app-text">{content.name}</span>
            <span>{formatSize(Number(content.size))}</span>
          </div>
          {!content.isText ? (
            <div className="rounded-lg bg-app-surface-muted p-3 text-sm text-app-text-soft">
              {t('sftp.preview.binaryWarning')}
            </div>
          ) : (
            <textarea
              readOnly
              value={content.content}
              className="h-[60vh] w-full resize-none rounded-lg border border-app-border bg-app-surface-muted p-3 font-mono text-xs text-app-text focus:outline-none"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
