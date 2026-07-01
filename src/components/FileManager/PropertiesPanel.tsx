import { useState } from 'react';
import { Input } from '@chakra-ui/react';
import { t } from '../../lib/i18n';
import { CloseIcon } from '../Icons';
import { formatFullModified, formatPermissionOctal, formatPermissionSymbolic, formatSize } from './lib/formatters';
import type { PermissionEditState, PropertiesState } from './types';
import type { RemoteFileEntry } from '../../types';

interface PropertiesPanelProps {
  properties: PropertiesState;
  permissionEdit?: PermissionEditState;
  working: boolean;
  ready: boolean;
  onClose: () => void;
  onPermissionEdit: (entry: RemoteFileEntry) => void;
  onPermissionChange: (value: string) => void;
  onPermissionCancel: () => void;
  onPermissionSave: () => void;
}

function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 rounded-[4px] px-2 py-2 hover:bg-[var(--fm-surface-elevated)]">
      <span className="text-[11px] font-medium leading-5 tracking-[0.02em] text-[var(--fm-text-muted)]">{label}</span>
      <span className="break-all text-[12px] leading-5 text-[var(--fm-text)]">{value}</span>
    </div>
  );
}

export function PropertiesPanel(props: PropertiesPanelProps) {
  const { entry } = props.properties;
  const [editValue, setEditValue] = useState(props.permissionEdit?.value ?? '');

  return (
    <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
      <div className="surface flex w-full max-w-md flex-col gap-2 rounded-[4px] p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.property.title')}</p>
            <h4 className="themed-heading mt-1 text-[15px] font-semibold tracking-[0.01em]">{entry.name}</h4>
          </div>
          <button aria-label={t('fileManager.property.close')} className="icon-btn" onClick={props.onClose} type="button">
            <CloseIcon />
          </button>
        </div>
        <div className="grid gap-1">
          <PropertyRow label={t('fileManager.property.name')} value={entry.name} />
          <PropertyRow label={t('fileManager.property.path')} value={entry.path} />
          <PropertyRow label={t('fileManager.property.directory')} value={props.properties.directoryPath} />
          <PropertyRow label={t('fileManager.property.type')} value={entry.kind} />
          <PropertyRow label={t('fileManager.property.size')} value={entry.kind === 'directory' ? '--' : formatSize(entry.size)} />
          <PropertyRow label={t('fileManager.property.modified')} value={formatFullModified(entry.modifiedAt)} />
          <PropertyRow label={t('fileManager.property.owner')} value={entry.ownerName ?? `UID ${entry.ownerUid ?? '--'}`} />
          <PropertyRow label={t('fileManager.property.group')} value={entry.groupName ?? `GID ${entry.groupGid ?? '--'}`} />
          <PropertyRow label={t('fileManager.property.permissions')} value={formatPermissionOctal(entry.permissions)} />
          <PropertyRow label={t('fileManager.property.permissionDetails')} value={formatPermissionSymbolic(entry.permissions, entry.kind)} />
        </div>
        {props.permissionEdit && props.permissionEdit.entry.path === entry.path ? (
          <div className="flex flex-col gap-2 rounded-[4px] border border-cyan-900/50 bg-cyan-950/20 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium tracking-[0.02em]">{t('fileManager.permissionEdit.label')}</span>
              <Input
                aria-label={t('fileManager.permissionEdit.label')}
                autoFocus
                className="themed-input w-20 px-2 py-1 font-mono text-[12px] leading-5"
                onChange={(e) => {
                  setEditValue(e.target.value);
                  props.onPermissionChange(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') props.onPermissionCancel();
                }}
                placeholder="0755"
                size="xs"
                value={editValue}
              />
              <span className="text-[11px] text-[var(--fm-text-muted)]">
                {formatPermissionSymbolic(parseInt(editValue.trim(), 8) || 0, entry.kind)}
              </span>
            </div>
            <div className="flex justify-end gap-1">
              <button className="icon-btn h-7 px-2 text-xs" onClick={props.onPermissionCancel} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button className="btn-primary h-7 px-2 text-xs" disabled={props.working} onClick={props.onPermissionSave} type="button">
                {t('fileManager.permissionEdit.save')}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="themed-menu-item w-full px-2 py-1 text-left text-[12px] font-medium"
            disabled={entry.permissions === undefined || !props.ready || props.working}
            onClick={() => props.onPermissionEdit(entry)}
            type="button"
          >
            {t('fileManager.menu.editPermissions')}
          </button>
        )}
      </div>
    </div>
  );
}
