import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import type { FileEntry } from '@/components/sftp/file-entry-formatters';
import { isRemoteEntry } from '@/components/sftp/file-entry-formatters';
import {
  formatSize,
  formatModified,
  kindLabel,
  formatPermissionSymbolic,
  formatPermissionOctal,
  formatOwner,
  formatGroup,
} from '@/lib/sftp-utils';

export interface SftpPropertiesDialogProps {
  entry?: FileEntry;
  open: boolean;
  onClose: () => void;
}

interface PropertyRowProps {
  label: string;
  value: string;
}

const PropertyRow: React.FC<PropertyRowProps> = ({ label, value }) => (
  <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2 px-1 py-2 text-sm">
    <span className="text-app-text-soft">{label}</span>
    <span className="break-all font-mono text-app-text">{value}</span>
  </div>
);

export const SftpPropertiesDialog: React.FC<SftpPropertiesDialogProps> = ({
  entry,
  open,
  onClose,
}) => {
  const { t, locale } = useI18n();

  if (!entry) return null;

  const remote = isRemoteEntry(entry);
  const permissionsText = remote
    ? `${formatPermissionSymbolic(entry.permissions, entry.kind)} (${formatPermissionOctal(entry.permissions)})`
    : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sftp.properties.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col py-2">
          <PropertyRow label={t('sftp.properties.name')} value={entry.name} />
          <PropertyRow label={t('sftp.properties.path')} value={entry.path} />
          <PropertyRow label={t('sftp.properties.kind')} value={kindLabel(entry.kind, t)} />
          <PropertyRow
            label={t('sftp.properties.size')}
            value={entry.kind === 'directory' ? '--' : formatSize(entry.size)}
          />
          <PropertyRow
            label={t('sftp.properties.modifiedAt')}
            value={formatModified(entry.modifiedAt, locale)}
          />
          {permissionsText && (
            <PropertyRow label={t('sftp.properties.permissions')} value={permissionsText} />
          )}
          {remote && (
            <PropertyRow
              label={t('sftp.properties.owner')}
              value={formatOwner(entry)}
            />
          )}
          {remote && (
            <PropertyRow
              label={t('sftp.properties.group')}
              value={formatGroup(entry)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
