import React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useI18n } from '@/hooks/useI18n';
import { useLastValue } from '@/hooks/useLastValue';
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
} from '@/lib/sftp/sftp-utils';

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
  const displayEntry = useLastValue(entry);

  // Only guard the initial mount: once a payload has been seen, the snapshot
  // keeps it alive during the exit animation so the fade-out isn't cut off.
  if (!displayEntry) return null;

  const remote = isRemoteEntry(displayEntry);
  const permissionsText = remote
    ? `${formatPermissionSymbolic(displayEntry.permissions, displayEntry.kind)} (${formatPermissionOctal(displayEntry.permissions)})`
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
          <PropertyRow label={t('sftp.properties.name')} value={displayEntry.name} />
          <PropertyRow label={t('sftp.properties.path')} value={displayEntry.path} />
          <PropertyRow label={t('sftp.properties.kind')} value={kindLabel(displayEntry.kind, t)} />
          <PropertyRow
            label={t('sftp.properties.size')}
            value={displayEntry.kind === 'directory' ? '--' : formatSize(displayEntry.size)}
          />
          <PropertyRow
            label={t('sftp.properties.modifiedAt')}
            value={formatModified(displayEntry.modifiedAt, locale)}
          />
          {permissionsText && (
            <PropertyRow label={t('sftp.properties.permissions')} value={permissionsText} />
          )}
          {remote && (
            <PropertyRow
              label={t('sftp.properties.owner')}
              value={formatOwner(displayEntry)}
            />
          )}
          {remote && (
            <PropertyRow
              label={t('sftp.properties.group')}
              value={formatGroup(displayEntry)}
            />
          )}
          </div>
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
