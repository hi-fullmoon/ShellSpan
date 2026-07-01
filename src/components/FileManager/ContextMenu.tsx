import { t } from '../../lib/i18n';
import { cn, fileKindColor } from '../../lib/ui';
import {
  FileIcon,
  FolderIcon,
  LinkIcon,
  DotsIcon,
  OpenIcon,
  EditIcon,
  PreviewIcon,
  DownloadIcon,
  CopyIcon,
  RenameIcon,
  TrashIcon,
  PropertiesIcon,
  ShieldIcon,
  RefreshIcon,
  BookmarkIcon,
  FilePlusIcon,
  FolderPlusIcon,
  UploadIcon,
  UploadFolderIcon,
} from '../Icons';
import type { MenuTarget } from './types';
import type { RemoteFileEntry, RemoteFileKind } from '../../types';

interface ContextMenuProps {
  target: MenuTarget;
  entry?: RemoteFileEntry;
  ready: boolean;
  readOnly: boolean;
  loading: boolean;
  working: boolean;
  bookmarks: string[];
  isCurrentPathBookmarked: boolean;
  clipboard?: { sourcePath: string };
  currentPath?: string;
  onOpen: (entry?: RemoteFileEntry) => void;
  onOpenWithDefaultEditor: (entry?: RemoteFileEntry) => void;
  onPreview: (entry?: RemoteFileEntry) => void;
  onDownload: (entry?: RemoteFileEntry) => void;
  onCopy: (entry?: RemoteFileEntry) => void;
  onRename: (entry?: RemoteFileEntry) => void;
  onDelete: (entry?: RemoteFileEntry) => void;
  onCopyName: (entry?: RemoteFileEntry) => void;
  onCopyPath: (entry?: RemoteFileEntry) => void;
  onCopyContainingDirectory: (entry?: RemoteFileEntry) => void;
  onPaste: () => void;
  onCopyCurrentDirectoryPath: () => void;
  onRefresh: () => void;
  onAddBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadFile: () => void;
  onUploadFolder: () => void;
  onProperties: (entry?: RemoteFileEntry) => void;
  onPermissionEdit: (entry?: RemoteFileEntry) => void;
}

function fileKindIcon(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return <FolderIcon />;
    case 'symlink':
      return <LinkIcon />;
    case 'other':
      return <DotsIcon />;
    default:
      return <FileIcon />;
  }
}

function MenuGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col py-1">{children}</div>;
}

function MenuDivider() {
  return <div className="themed-menu-divider my-1 h-px" />;
}

function MenuItem({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="themed-menu-item flex items-center gap-2 px-2 py-1.5 text-left text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon ? <span className="h-4 w-4 text-[var(--fm-text-muted)]">{icon}</span> : null}
      {label}
    </button>
  );
}

export function FileManagerContextMenu(props: ContextMenuProps) {
  const canAct = props.ready && !props.loading && !props.working;
  const canWrite = canAct && !props.readOnly;

  if (props.target === 'entry' && props.entry) {
    const entry = props.entry;
    const isDirectory = entry.kind === 'directory';
    const isBookmarked = props.bookmarks.includes(entry.path);

    return (
      <div className="themed-menu min-w-44 rounded-[4px] p-1 backdrop-blur" role="menu">
        <MenuGroup>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className={cn('inline-flex h-4 w-4 items-center justify-center', fileKindColor(entry.kind))}>
              {fileKindIcon(entry.kind)}
            </span>
            <span className="max-w-[200px] truncate text-[12px] font-semibold text-[var(--fm-text)]">{entry.name}</span>
          </div>
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          {isDirectory ? (
            <MenuItem icon={<OpenIcon />} label={t('fileManager.menu.open')} onClick={() => props.onOpen(entry)} />
          ) : (
            <>
              <MenuItem icon={<EditIcon />} label={t('fileManager.menu.openWithDefaultEditor')} onClick={() => props.onOpenWithDefaultEditor(entry)} />
              <MenuItem icon={<PreviewIcon />} label={t('fileManager.menu.preview')} onClick={() => props.onPreview(entry)} />
            </>
          )}
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <MenuItem icon={<DownloadIcon />} label={t('fileManager.menu.download')} onClick={() => props.onDownload(entry)} />
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <MenuItem icon={<CopyIcon />} label={t('fileManager.menu.copy')} onClick={() => props.onCopy(entry)} />
          <MenuItem icon={<RenameIcon />} label={t('fileManager.menu.rename')} onClick={() => props.onRename(entry)} />
          <MenuItem icon={<TrashIcon />} label={t('common.delete')} onClick={() => props.onDelete(entry)} />
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <MenuItem label={t('fileManager.menu.copyName')} onClick={() => props.onCopyName(entry)} />
          <MenuItem label={t('fileManager.menu.copyFilePath')} onClick={() => props.onCopyPath(entry)} />
          <MenuItem label={t('fileManager.menu.copyContainingDirectory')} onClick={() => props.onCopyContainingDirectory(entry)} />
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <MenuItem
            icon={<BookmarkIcon />}
            label={isBookmarked ? t('fileManager.bookmarks.remove') : t('fileManager.bookmarks.add')}
            onClick={() => {
              if (isBookmarked) props.onRemoveBookmark(entry.path);
              else props.onAddBookmark(entry.path);
            }}
          />
          <MenuItem icon={<RefreshIcon />} label={t('fileManager.actions.refresh')} onClick={props.onRefresh} />
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <MenuItem icon={<ShieldIcon />} label={t('fileManager.menu.editPermissions')} onClick={() => props.onPermissionEdit(entry)} />
          <MenuItem icon={<PropertiesIcon />} label={t('fileManager.menu.properties')} onClick={() => props.onProperties(entry)} />
        </MenuGroup>
      </div>
    );
  }

  return (
    <div className="themed-menu min-w-44 rounded-[4px] p-1 backdrop-blur" role="menu">
      <MenuGroup>
        <div className="px-2 py-1.5 text-[12px] font-semibold text-[var(--fm-text)]">
          {t('fileManager.menu.currentDirectory', { path: props.currentPath ?? '' })}
        </div>
      </MenuGroup>
      <MenuDivider />
      <MenuGroup>
        <MenuItem icon={<FilePlusIcon />} label={t('fileManager.menu.newFile')} onClick={props.onNewFile} />
        <MenuItem icon={<FolderPlusIcon />} label={t('fileManager.menu.newDirectory')} onClick={props.onNewFolder} />
        <MenuItem icon={<UploadIcon />} label={t('fileManager.menu.uploadFile')} onClick={props.onUploadFile} />
        <MenuItem icon={<UploadFolderIcon />} label={t('fileManager.menu.uploadFolder')} onClick={props.onUploadFolder} />
      </MenuGroup>
      <MenuDivider />
      <MenuGroup>
        <MenuItem icon={<CopyIcon />} label={t('fileManager.menu.paste')} disabled={!canWrite || !props.clipboard} onClick={props.onPaste} />
        <MenuItem label={t('fileManager.menu.copyCurrentDirectoryPath')} onClick={props.onCopyCurrentDirectoryPath} />
      </MenuGroup>
      <MenuDivider />
      <MenuGroup>
        <MenuItem icon={<RefreshIcon />} label={t('fileManager.actions.refresh')} onClick={props.onRefresh} />
        {props.currentPath ? (
          <MenuItem
            icon={<BookmarkIcon />}
            label={props.isCurrentPathBookmarked ? t('fileManager.bookmarks.remove') : t('fileManager.bookmarks.add')}
            onClick={() => {
              if (props.isCurrentPathBookmarked) props.onRemoveBookmark(props.currentPath!);
              else props.onAddBookmark(props.currentPath!);
            }}
          />
        ) : null}
      </MenuGroup>
    </div>
  );
}
