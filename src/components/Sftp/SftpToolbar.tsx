import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';

export interface SftpToolbarProps {
  onNewFolder: () => void;
  onUpload: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: () => void;
  onPermissions: () => void;
}

export const SftpToolbar: React.FC<SftpToolbarProps> = ({
  onNewFolder,
  onUpload,
  onDownload,
  onDelete,
  onRename,
  onPermissions,
}) => {
  const { t } = useI18n();

  return (
    <div className="flex h-9 items-center gap-1 border-b border-app-border bg-app-surface-muted px-2">
      <Button variant="secondary" size="sm" onClick={onNewFolder}>
        {t('common.newFolder')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onUpload}>
        {t('common.upload')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onDownload}>
        {t('common.download')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onRename}>
        {t('common.rename')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onPermissions}>
        {t('common.permissions')}
      </Button>
      <Button variant="danger" size="sm" onClick={onDelete}>
        {t('common.delete')}
      </Button>
    </div>
  );
};
