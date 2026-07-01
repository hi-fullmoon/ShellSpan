import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui';
import { Input } from '@chakra-ui/react';
import {
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FilePlusIcon,
  FolderPlusIcon,
  ListIcon,
  CompactIcon,
  RefreshIcon,
  TrashIcon,
  UploadFolderIcon,
  UploadIcon,
} from '../Icons';
import { PathBreadcrumb } from './PathBreadcrumb';

interface ToolbarProps {
  ready: boolean;
  readOnly: boolean;
  loading: boolean;
  working: boolean;
  currentPath?: string;
  filterQuery: string;
  viewMode: 'list' | 'compact';
  selectedCount: number;
  onNavigate: (path: string) => void;
  onCopyPath: () => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadFile: () => void;
  onUploadFolder: () => void;
  onDownload: () => void;
  onFilterChange: (value: string) => void;
  onViewModeChange: (mode: 'list' | 'compact') => void;
  onBatchDownload: () => void;
  onBatchDelete: () => void;
  onBatchCopy: () => void;
  onClearSelection: () => void;
}

function ToolbarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex h-7 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--fm-text-soft)] hover:bg-[var(--fm-surface-elevated)] hover:text-[var(--fm-text)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="h-4 w-4">{icon}</span>
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

export function Toolbar(props: ToolbarProps) {
  const canAct = props.ready && !props.loading && !props.working;
  const canWrite = canAct && !props.readOnly;

  return (
    <div className="flex flex-col gap-1">
      <PathBreadcrumb
        currentPath={props.currentPath}
        disabled={!props.ready || props.loading || props.working}
        onCopyPath={props.onCopyPath}
        onNavigate={props.onNavigate}
      />
      <div className="flex items-center gap-1">
        <div className="flex flex-1 items-center gap-0.5">
          <ToolbarButton disabled={!canAct} icon={<RefreshIcon />} label={t('fileManager.actions.refresh')} onClick={props.onRefresh} />
          <ToolbarButton disabled={!canWrite} icon={<FilePlusIcon />} label={t('fileManager.menu.newFile')} onClick={props.onNewFile} />
          <ToolbarButton disabled={!canWrite} icon={<FolderPlusIcon />} label={t('fileManager.menu.newDirectory')} onClick={props.onNewFolder} />
          <ToolbarButton disabled={!canWrite} icon={<UploadIcon />} label={t('fileManager.menu.uploadFile')} onClick={props.onUploadFile} />
          <ToolbarButton disabled={!canWrite} icon={<UploadFolderIcon />} label={t('fileManager.menu.uploadFolder')} onClick={props.onUploadFolder} />
          <ToolbarButton disabled={!canAct || !props.selectedCount} icon={<DownloadIcon />} label={t('fileManager.menu.download')} onClick={props.onDownload} />
        </div>
        <div className="flex items-center gap-1">
          <Input
            className="themed-input h-7 w-28 px-2 py-0.5 text-[11px] leading-5"
            onChange={(e) => props.onFilterChange(e.target.value)}
            placeholder={t('fileManager.filterPlaceholder')}
            size="xs"
            type="text"
            value={props.filterQuery}
          />
          <div className="flex items-center rounded-[4px] border border-[var(--fm-border)] p-0.5">
            <button
              aria-label={t('fileManager.view.list')}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-[2px]',
                props.viewMode === 'list' ? 'bg-[var(--fm-surface-elevated)] text-[var(--fm-text)]' : 'text-[var(--fm-text-muted)]',
              )}
              onClick={() => props.onViewModeChange('list')}
              type="button"
            >
              <ListIcon />
            </button>
            <button
              aria-label={t('fileManager.view.compact')}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-[2px]',
                props.viewMode === 'compact' ? 'bg-[var(--fm-surface-elevated)] text-[var(--fm-text)]' : 'text-[var(--fm-text-muted)]',
              )}
              onClick={() => props.onViewModeChange('compact')}
              type="button"
            >
              <CompactIcon />
            </button>
          </div>
        </div>
      </div>
      {props.selectedCount > 1 ? (
        <div className="flex items-center gap-1 rounded-[4px] bg-[var(--fm-primary-dim)] px-2 py-1">
          <span className="text-[11px] text-[var(--fm-text-soft)]">
            {t('fileManager.batch.selected', { count: props.selectedCount })}
          </span>
          <div className="flex-1" />
          <button className="icon-btn h-6 px-1.5 text-[11px]" disabled={!canAct} onClick={props.onBatchDownload} type="button">
            <DownloadIcon />
            {t('fileManager.menu.download')}
          </button>
          <button className="icon-btn h-6 px-1.5 text-[11px]" disabled={!canAct} onClick={props.onBatchCopy} type="button">
            <CopyIcon />
            {t('fileManager.menu.copy')}
          </button>
          <button
            className="icon-btn h-6 px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
            disabled={!canWrite}
            onClick={props.onBatchDelete}
            type="button"
          >
            <TrashIcon />
            {t('common.delete')}
          </button>
          <button className="icon-btn h-6 w-6 px-0 text-[10px]" onClick={props.onClearSelection} type="button">
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
