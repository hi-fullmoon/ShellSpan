import React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import {
  SftpDialogBody,
  SftpDialogContent,
  SftpDialogHeader,
} from './sftp-dialog-layout';
import type { FileEntry } from '@/components/sftp/utils';
import { isRemoteEntry } from '@/components/sftp/utils';
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
  <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm">
    <span className="text-xs text-app-text-soft">{label}</span>
    <span className="break-all text-right font-mono text-xs leading-5 text-app-text">{value}</span>
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
      <SftpDialogContent className="max-w-sm">
        <SftpDialogHeader title={t('sftp.properties.title')} />
        <SftpDialogBody>
          <div
            data-slot="properties-content"
            className="flex flex-col overflow-hidden rounded-md border border-app-border bg-app-surface-muted/30"
          >
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
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
