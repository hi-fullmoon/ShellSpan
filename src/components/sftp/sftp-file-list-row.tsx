import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FolderIcon, LinkIcon, FileIcon as LucideFileIcon } from 'lucide-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { elideMiddle, measureTextWidth } from '@/lib/elide-middle';
import { useI18n } from '@/hooks/useI18n';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { RemoteFileKind } from '@/types';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './utils';
import {
  formatGroup,
  formatOwner,
  formatPermissionSymbolic,
  isRemoteEntry,
} from './utils';
import type { SftpDndPayload } from './sftp-dnd-context';

export interface SftpFileListRowProps {
  entry: FileEntry;
  side: SftpSide;
  presentationSide?: SftpSide;
  selected: boolean;
  batchMode: boolean;
  selectedEntries: FileEntry[];
  onSelect: (entry: FileEntry, e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
}

export const FileIcon: React.FC<{ kind: RemoteFileKind; selected?: boolean }> = ({ kind, selected }) => {
  if (kind === 'directory') {
    return <FolderIcon className="h-4 w-4 shrink-0 text-app-primary" />;
  }
  if (kind === 'symlink') {
    return <LinkIcon className="h-4 w-4 shrink-0 text-app-primary" />;
  }
  return <LucideFileIcon className={cn('h-4 w-4 shrink-0', selected ? 'text-app-primary' : 'text-app-text-soft')} />;
};

// Split a file name into stem + extension so the extension can stay pinned
// visible while only the stem truncates (like Finder/Explorer file lists).
// Dotfiles (".gitignore"), names ending with a dot, and overly long
// "extensions" are treated as having none.
function splitFileName(
  name: string,
  kind: RemoteFileKind,
): { stem: string; extension: string } {
  if (kind === 'directory') return { stem: name, extension: '' };
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { stem: name, extension: '' };
  }
  const extension = name.slice(dotIndex);
  if (extension.length > 10) return { stem: name, extension: '' };
  return { stem: name.slice(0, dotIndex), extension };
}

function getKindLabel(
  kind: RemoteFileKind,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (kind) {
    case 'directory':
      return t('sftp.kind.directory');
    case 'file':
      return t('sftp.kind.file');
    case 'symlink':
      return t('sftp.kind.symlink');
    case 'other':
    default:
      return t('sftp.kind.other');
  }
}

export const SftpFileListRow: React.FC<SftpFileListRowProps> = ({
  entry,
  side,
  presentationSide = side,
  selected,
  batchMode,
  selectedEntries,
  onSelect,
  onDoubleClick,
  onContextMenu,
}) => {
  const { t } = useI18n();
  const { stem: nameStem, extension: nameExtension } = splitFileName(
    entry.name,
    entry.kind,
  );
  const containerRef = useRef<HTMLSpanElement>(null);
  const fileNameRef = useRef<HTMLSpanElement>(null);
  const fontRef = useRef('');
  const [displayStem, setDisplayStem] = useState(nameStem);
  const [isFileNameTruncated, setIsFileNameTruncated] = useState(false);

  const updateFileNameDisplay = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // The font string only changes with theme/density switches, so cache it
    // instead of forcing a style recalculation on every resize callback.
    let font = fontRef.current;
    if (!font) {
      const style = window.getComputedStyle(container);
      font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      fontRef.current = font;
    }
    const extensionWidth = nameExtension ? measureTextWidth(nameExtension, font) : 0;
    const fullWidth = measureTextWidth(nameStem, font);
    if (fullWidth === null || extensionWidth === null) {
      // Canvas measurement unavailable (e.g. jsdom): plain CSS truncation.
      setDisplayStem(nameStem);
      const element = fileNameRef.current;
      if (element) {
        const nextIsTruncated = element.scrollWidth > element.clientWidth;
        setIsFileNameTruncated((current) =>
          current === nextIsTruncated ? current : nextIsTruncated,
        );
      }
      return;
    }
    // Canvas is available past this point; the fallback only narrows the type.
    const measure = (s: string): number => measureTextWidth(s, font) ?? 0;
    // 1px safety margin: canvas metrics can differ from real DOM layout by
    // subpixel amounts, which would otherwise add a second, CSS ellipsis.
    const maxStemWidth = container.clientWidth - extensionWidth - 1;
    const nextIsTruncated = fullWidth > maxStemWidth;
    const nextDisplayStem = nextIsTruncated
      ? elideMiddle(nameStem, maxStemWidth, measure)
      : nameStem;
    setDisplayStem((current) =>
      current === nextDisplayStem ? current : nextDisplayStem,
    );
    setIsFileNameTruncated((current) =>
      current === nextIsTruncated ? current : nextIsTruncated,
    );
  }, [nameStem, nameExtension]);

  useLayoutEffect(() => {
    updateFileNameDisplay();
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateFileNameDisplay);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateFileNameDisplay]);

  // Web fonts may load after the first measurement; re-measure once they are
  // ready so elision is computed against the real font metrics.
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (!fonts) return;
    let cancelled = false;
    void fonts.ready.then(() => {
      if (!cancelled) updateFileNameDisplay();
    });
    return () => {
      cancelled = true;
    };
  }, [updateFileNameDisplay]);

  const dragPayload: SftpDndPayload = useMemo(() => {
    const entries = selected ? selectedEntries : [entry];
    return { side, entries };
  }, [selected, selectedEntries, entry, side]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sftp-row-${side}-${entry.path}`,
    data: dragPayload,
    disabled: false,
  });

  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    // On the second click of a double-click sequence (detail=2), skip the
    // single-click action and let handleDoubleClick take over. This prevents
    // onSelect from firing twice before onDoubleClick.
    if (e.detail === 2) {
      return;
    }
    onSelect(entry, e);
  };

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onDoubleClick(entry);
  };

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(entry, e);
  };

  const remote = isRemoteEntry(entry);
  const permissionText = remote
    ? formatPermissionSymbolic(entry.permissions, entry.kind)
    : undefined;
  const mutedTextClass = selected ? 'text-app-primary' : 'text-app-text-soft';
  const cellStateClass = cn(
    'border-b border-app-border/50 transition-colors',
    selected ? 'bg-app-primary/10' : 'group-hover:bg-app-surface-muted',
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onMouseDownCapture={(e) => {
        // Tauri's WebView (WebKit) starts a native mouse-drag autoscroll when a
        // drag gesture crosses a scrollable edge — this is what makes the source
        // list scroll horizontally during a cross-pane drag. The drag itself is
        // driven by dnd-kit via pointer events, so cancelling the mouse gesture
        // here (and restoring the focus preventDefault would otherwise swallow)
        // suppresses that autoscroll without affecting click, drag, or focus.
        if (e.button === 0) {
          e.preventDefault();
          e.currentTarget.focus();
        }
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        'group grid h-full cursor-default select-none items-center px-2 text-xs',
        isDragging && 'opacity-50',
      )}
      style={{
        gridTemplateColumns:
          presentationSide === 'remote'
            ? 'minmax(300px, 1fr) 148px 88px 96px 88px 88px'
            : 'minmax(300px, 1fr) 148px 88px 96px',
      }}
    >
      <div
        data-sftp-file-cell
        className={cn(
          'flex h-full min-w-0 items-center gap-1.5 -ml-2 pr-2 pl-2',
          cellStateClass,
          selected ? 'text-app-primary' : 'text-app-text',
        )}
      >
        {batchMode && (
          <Checkbox checked={selected} className="h-3.5 w-3.5 shrink-0" />
        )}
        <FileIcon kind={entry.kind} selected={selected} />
        {/* flex-1 keeps this box at full available width even after the stem
            is elided, so the ResizeObserver on the name container still sees
            real layout width changes instead of the shrunken content width. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
          <Tooltip disabled={!isFileNameTruncated}>
            <TooltipTrigger
              render={
                <span
                  ref={containerRef}
                  className="flex min-w-0 text-[13px] font-medium"
                  onMouseEnter={updateFileNameDisplay}
                />
              }
            >
              <span ref={fileNameRef} className="truncate">
                {displayStem}
              </span>
              {nameExtension && <span className="shrink-0">{nameExtension}</span>}
            </TooltipTrigger>
            <TooltipContent className="break-all">{entry.name}</TooltipContent>
          </Tooltip>
          {permissionText && (
            <span className={cn('truncate font-mono text-[11px]', mutedTextClass)}>
              {permissionText}
            </span>
          )}
        </div>
      </div>

      <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 tabular-nums', cellStateClass, mutedTextClass)}>
        {entry.modifiedAt ? formatDate(entry.modifiedAt) : '--'}
      </div>

      <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 tabular-nums', cellStateClass, mutedTextClass)}>
        {entry.kind === 'directory' ? '--' : formatBytes(entry.size)}
      </div>

      <div
        data-sftp-file-cell
        className={cn(
          'flex h-full items-center truncate pr-2',
          presentationSide === 'local' && '-mr-2',
          cellStateClass,
          mutedTextClass,
        )}
      >
        {getKindLabel(entry.kind, t)}
      </div>

      {presentationSide === 'remote' && remote && (
        <>
          <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 font-mono', cellStateClass, mutedTextClass)}>
            {formatOwner(entry)}
          </div>
          <div data-sftp-file-cell className={cn('flex h-full items-center truncate -mr-2 pr-2 font-mono', cellStateClass, mutedTextClass)}>
            {formatGroup(entry)}
          </div>
        </>
      )}
    </div>
  );
};
