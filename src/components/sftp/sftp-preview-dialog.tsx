import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useLastValue } from '@/hooks/useLastValue';
import type { SftpPreviewFileActions, SftpPreviewTarget } from '@/hooks/useSftpPaneActions';
import { formatSize } from '@/lib/sftp/sftp-utils';
import { createPreviewDataUrl, formatHexPreviewRows, getFileExtension, getSftpPreviewDescriptor, type SftpPreviewDescriptor } from '@/lib/sftp/sftp-preview';
import { cn } from '@/lib/utils';
import type { ReadRemoteFileResponse } from '@/types';
import { BinaryIcon, FileIcon, RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { SftpDialogBody, SftpDialogContent } from './sftp-dialog-layout';
import { SftpPreviewOpenControls } from './sftp-preview-file-actions';
import { sftpPreviewContentClassName, SftpPreviewNotice, SftpPreviewPage, SftpPreviewScrollArea, SftpPreviewTable, SftpPreviewToolbar } from './sftp-preview-layout';
import {
  ArchivePreview,
  MarkdownPreview,
  OfficeDocumentPreview,
  PlainTextPreview,
  StructuredDataPreview,
} from './sftp-rich-preview';

export interface SftpPreviewDialogProps {
  target?: SftpPreviewTarget;
  content?: ReadRemoteFileResponse;
  open: boolean;
  onClose: () => void;
  fileActions?: SftpPreviewFileActions;
}

interface PreviewRendererProps {
  content: ReadRemoteFileResponse;
  descriptor: SftpPreviewDescriptor;
}

const MediaUnavailable: React.FC = () => {
  const { t } = useI18n();
  return (
    <SftpPreviewNotice
      title={t('sftp.preview.mediaUnavailableTitle')}
      description={t('sftp.preview.mediaUnavailableDescription')}
    />
  );
};

const ImagePreview: React.FC<{ dataUrl: string; name: string }> = ({ dataUrl, name }) => {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number }>();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const fitImageToViewport = useCallback((image: HTMLImageElement) => {
    const sourceWidth = image.naturalWidth || image.clientWidth;
    const sourceHeight = image.naturalHeight || image.clientHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    // Reserve 16 px on each side, 8 px above, and 16 px below the fitted image.
    const viewportWidth = viewportRef.current?.clientWidth ?? 0;
    const viewportHeight = viewportRef.current?.clientHeight ?? 0;
    const availableWidth = viewportWidth > 32 ? viewportWidth - 32 : sourceWidth;
    const availableHeight = viewportHeight > 24 ? viewportHeight - 24 : sourceHeight;
    const scale = Math.min(1, availableWidth / sourceWidth, availableHeight / sourceHeight);
    setRenderedSize({
      width: Math.floor(sourceWidth * scale),
      height: Math.floor(sourceHeight * scale),
    });
  }, []);

  useEffect(() => {
    setZoom(1);
    setFailed(false);
    setRenderedSize(undefined);
  }, [dataUrl]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitImageToViewport(image));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [dataUrl, fitImageToViewport]);

  if (failed) return <MediaUnavailable />;

  return (
    <>
      <SftpPreviewToolbar>
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
                disabled={zoom <= 0.25}
              />
            }>
              <ZoomOutIcon />
              <span className="sr-only">{t('sftp.preview.zoomOut')}</span>
            </TooltipTrigger>
            <TooltipContent>{t('sftp.preview.zoomOut')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={
              <Button variant="ghost" size="icon-sm" onClick={() => setZoom((value) => Math.min(4, value + 0.25))} disabled={zoom >= 4} />
            }>
              <ZoomInIcon />
              <span className="sr-only">{t('sftp.preview.zoomIn')}</span>
            </TooltipTrigger>
            <TooltipContent>{t('sftp.preview.zoomIn')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setZoom(1)} disabled={zoom === 1} />}>
              <RotateCcwIcon />
              <span className="sr-only">{t('sftp.preview.resetZoom')}</span>
            </TooltipTrigger>
            <TooltipContent>{t('sftp.preview.resetZoom')}</TooltipContent>
          </Tooltip>
        </div>
      </SftpPreviewToolbar>
      <SftpPreviewScrollArea viewportRef={viewportRef} horizontal>
        <div className="grid min-h-full w-max min-w-full place-items-center px-4 pt-2 pb-4">
          <img
            ref={imageRef}
            src={dataUrl}
            alt={name}
            onError={() => setFailed(true)}
            onLoad={(event) => fitImageToViewport(event.currentTarget)}
            className={cn('block rounded-md object-contain shadow-sm', renderedSize ? 'max-h-none max-w-none' : 'max-h-[60vh] max-w-full')}
            style={
              renderedSize
                ? {
                    width: renderedSize.width * zoom,
                    height: renderedSize.height * zoom,
                  }
                : undefined
            }
          />
        </div>
      </SftpPreviewScrollArea>
    </>
  );
};

const MediaPreview: React.FC<{ dataUrl: string; kind: 'audio' | 'video'; name: string }> = ({ dataUrl, kind, name }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [dataUrl]);
  if (failed) return <MediaUnavailable />;

  return (
    <div className={cn(sftpPreviewContentClassName, 'flex items-center justify-center px-4 pt-2 pb-4')}>
      {kind === 'audio' ? (
        <audio aria-label={name} className="w-full max-w-lg" controls src={dataUrl} onError={() => setFailed(true)} />
      ) : (
        <video aria-label={name} className="max-h-full max-w-full rounded-lg bg-black shadow-sm" controls src={dataUrl} onError={() => setFailed(true)} />
      )}
    </div>
  );
};

const BinaryPreview: React.FC<{ content: string; isArchive: boolean }> = ({ content, isArchive }) => {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const rows = useMemo(() => formatHexPreviewRows(content), [content]);
  return (
    <SftpPreviewScrollArea className="bg-app-surface" horizontal size="default">
      <div className="mx-auto max-w-3xl @min-4xl/preview:px-6">
        <div className="sticky left-0 flex items-start gap-1 px-4 py-2 leading-5">
          <BinaryIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col @min-xl/preview:flex-row @min-xl/preview:items-baseline @min-xl/preview:gap-2">
            <h2 id={titleId} className="text-sm font-medium">
              {isArchive ? t('sftp.preview.archiveTitle') : t('sftp.preview.binaryTitle')}
            </h2>
            <p id={descriptionId} className="text-xs text-muted-foreground">{t('sftp.preview.hexDescription')}</p>
          </div>
        </div>
        <SftpPreviewTable className="min-w-max" aria-labelledby={titleId} aria-describedby={descriptionId}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-24">{t('sftp.preview.hex.offset')}</TableHead>
              <TableHead scope="col">{t('sftp.preview.hex.bytes')}</TableHead>
              <TableHead scope="col" className="w-44">{t('sftp.preview.hex.ascii')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono">
            {rows.map(({ offset, hex, ascii }) => (
              <TableRow key={offset} className="even:bg-muted/25">
                <TableCell className="text-muted-foreground">{offset}</TableCell>
                <TableCell className="whitespace-pre">{hex}</TableCell>
                <TableCell className="whitespace-pre text-muted-foreground">{ascii}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </SftpPreviewTable>
      </div>
    </SftpPreviewScrollArea>
  );
};

const FontPreview: React.FC<{ dataUrl: string }> = ({ dataUrl }) => {
  const { t } = useI18n();
  const [family, setFamily] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFamily(undefined);
    setFailed(false);
    if (typeof FontFace === 'undefined' || !document.fonts) {
      setFailed(true);
      return undefined;
    }
    let active = true;
    const familyName = `ShellSpanPreview-${Date.now().toString(36)}`;
    const fontFace = new FontFace(familyName, `url("${dataUrl}")`);
    void fontFace
      .load()
      .then((loaded) => {
        if (!active) return;
        document.fonts.add(loaded);
        setFamily(familyName);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      document.fonts.delete(fontFace);
    };
  }, [dataUrl]);

  if (failed) return <MediaUnavailable />;
  return (
    <SftpPreviewScrollArea>
      <SftpPreviewPage className="gap-5 wrap-anywhere" style={{ fontFamily: family }}>
        <p className="text-xs text-muted-foreground">{family ? t('sftp.preview.fontLoaded') : t('sftp.preview.fontLoading')}</p>
        <p className="text-6xl leading-tight">Aa 字</p>
        <p className="text-2xl leading-relaxed">The quick brown fox jumps over the lazy dog.</p>
        <p className="text-2xl leading-relaxed">天地玄黄，宇宙洪荒。你好，世界。</p>
        <p className="text-xl tracking-wide">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>
        <p className="text-xl tracking-wide">abcdefghijklmnopqrstuvwxyz</p>
        <p className="text-xl tracking-wide">0123456789 !@#$%^&amp;*()</p>
      </SftpPreviewPage>
    </SftpPreviewScrollArea>
  );
};

const PreviewRenderer: React.FC<PreviewRendererProps> = ({ content, descriptor }) => {
  const { t } = useI18n();
  if (descriptor.kind === 'unavailable') {
    return (
      <SftpPreviewNotice
        title={t('sftp.preview.tooLargeTitle')}
        description={t('sftp.preview.tooLargeDescription')}
      />
    );
  }
  if (descriptor.kind === 'text') return <PlainTextPreview content={content.content} fileName={content.name} />;
  if (descriptor.kind === 'markdown') return <MarkdownPreview content={content.content} fileName={content.name} />;
  if (descriptor.kind === 'data') return <StructuredDataPreview content={content.content} extension={descriptor.extension} fileName={content.name} />;
  const dataUrl =
    content.contentEncoding === 'base64'
      ? createPreviewDataUrl(content.content, descriptor.mimeType)
      : descriptor.kind === 'image' && descriptor.extension === 'svg'
        ? `data:${descriptor.mimeType};charset=utf-8,${encodeURIComponent(content.content)}`
        : '';
  if (descriptor.kind === 'image') return <ImagePreview dataUrl={dataUrl} name={content.name} />;
  if (descriptor.kind === 'audio' || descriptor.kind === 'video') {
    return <MediaPreview dataUrl={dataUrl} kind={descriptor.kind} name={content.name} />;
  }
  if (descriptor.kind === 'pdf') {
    return <iframe className={cn(sftpPreviewContentClassName, 'w-full')} src={dataUrl} title={content.name} />;
  }
  if (descriptor.kind === 'font') return <FontPreview dataUrl={dataUrl} />;
  if (descriptor.kind === 'document' || descriptor.kind === 'spreadsheet' || descriptor.kind === 'presentation') {
    return <OfficeDocumentPreview content={content.content} extension={descriptor.extension} />;
  }
  if (descriptor.kind === 'archive') {
    return (
      <ArchivePreview
        content={content.content}
        extension={descriptor.extension}
        fallback={<BinaryPreview content={content.content} isArchive />}
      />
    );
  }
  return <BinaryPreview content={content.content} isArchive={false} />;
};

export const SftpPreviewDialog: React.FC<SftpPreviewDialogProps> = ({ target, content, open, onClose, fileActions }) => {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const liveTarget = useMemo(
    () => target ?? (content ? { path: content.path, name: content.name, size: content.size } : undefined),
    [content, target],
  );
  const displayTarget = useLastValue(liveTarget);
  const lookupDefaultIcon = fileActions?.getDefaultApplicationIcon;
  const previewPath = liveTarget?.path;
  const previewName = liveTarget?.name;
  const [defaultApplicationIcon, setDefaultApplicationIcon] = useState<{
    path: string;
    name: string;
    lookup: SftpPreviewFileActions['getDefaultApplicationIcon'];
    icon: string;
  }>();
  useEffect(() => {
    setDefaultApplicationIcon(undefined);
    if (!open || !previewPath || !previewName || !lookupDefaultIcon) return;
    let current = true;
    void lookupDefaultIcon({ path: previewPath, name: previewName }).then((icon) => {
      if (current && icon) setDefaultApplicationIcon({ path: previewPath, name: previewName, lookup: lookupDefaultIcon, icon });
    }, () => undefined);
    return () => { current = false; };
  }, [lookupDefaultIcon, open, previewName, previewPath]);
  const displayContent = useLastValue(content);
  const loading = target !== undefined && content === undefined;
  const resolvedContent = loading ? undefined : displayContent;
  const descriptor = useMemo(
    () => (resolvedContent ? getSftpPreviewDescriptor(resolvedContent.name, resolvedContent.contentEncoding) : undefined),
    [resolvedContent],
  );

  if (!displayTarget || (!loading && (!resolvedContent || !descriptor))) return null;
  const FileTypeIcon = descriptor?.icon ?? FileIcon;
  const extension = descriptor?.extension ?? getFileExtension(displayTarget.name);
  const extensionLabel = extension
    ? extension.toUpperCase()
    : descriptor ? t(`sftp.preview.kind.${descriptor.kind}`) : t('sftp.preview.loading');
  const displaySize = resolvedContent?.size ?? displayTarget.size;
  const formattedSize = displaySize !== undefined ? formatSize(Number(displaySize)) : undefined;
  const isPartial = resolvedContent?.truncated && resolvedContent.contentEncoding !== 'none';
  const icon = defaultApplicationIcon?.path === displayTarget.path && defaultApplicationIcon.name === displayTarget.name
    && defaultApplicationIcon.lookup === lookupDefaultIcon ? defaultApplicationIcon.icon : undefined;
  const fileActionControls = fileActions && (
    <SftpPreviewOpenControls key={displayTarget.path} target={displayTarget} actions={fileActions} defaultIcon={icon} />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SftpDialogContent
        ref={dialogRef}
        initialFocus={dialogRef}
        showCloseButton={false}
        className="h-[90vh] max-h-[calc(100vh-2rem)] max-w-6xl rounded-lg"
      >
        <DialogHeader className="shrink-0 gap-1.5 px-3 pt-3 pb-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="flex min-w-0 flex-1 items-center gap-1 text-sm leading-5 font-semibold">
              <FileTypeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger render={<span className="truncate" />}>{displayTarget.name}</TooltipTrigger>
                <TooltipContent className="max-w-sm break-all">{displayTarget.name}</TooltipContent>
              </Tooltip>
            </DialogTitle>
            {fileActionControls}
            <DialogClose render={<Button variant="ghost" size="icon-sm" className="shrink-0" />}>
              <XIcon />
              <span className="sr-only">{t('common.close')}</span>
            </DialogClose>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <DialogDescription className="min-w-0 truncate text-xs leading-5" title={displayTarget.path}>
              {displayTarget.path}
            </DialogDescription>
            <div data-slot="sftp-preview-metadata" className="flex min-w-0 max-w-[65%] shrink-0 items-center gap-2">
              <Badge variant="secondary" className="min-w-0 shrink" title={extensionLabel}>
                <span className="min-w-0 truncate">{extensionLabel}</span>
              </Badge>
              {formattedSize !== undefined && (
                <span data-slot="sftp-preview-file-size" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                  {formattedSize}
                </span>
              )}
              {isPartial && <Badge variant="outline">{t('sftp.preview.partial')}</Badge>}
            </div>
          </div>
        </DialogHeader>
        <SftpDialogBody
          data-slot="sftp-preview-surface"
          className="@container/preview flex-1 gap-0 overflow-hidden border-t border-app-border/65 bg-app-bg p-0"
        >
          {loading ? (
            <SftpPreviewScrollArea>
              <div className="flex min-h-full items-center justify-center pt-2" role="status">
                <EmptyState
                  title={t('sftp.preview.loading')}
                  description={t('sftp.preview.loadingDescription')}
                  icon={<Spinner className="text-primary" size={24} aria-hidden="true" />}
                />
              </div>
            </SftpPreviewScrollArea>
          ) : resolvedContent && descriptor && (
            <PreviewRenderer content={resolvedContent} descriptor={descriptor} />
          )}
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
