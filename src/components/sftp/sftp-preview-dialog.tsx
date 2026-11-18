import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/empty-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useLastValue } from '@/hooks/useLastValue';
import type { SftpPreviewFileActions, SftpPreviewTarget } from '@/hooks/useSftpPaneActions';
import { formatSize } from '@/lib/sftp/sftp-utils';
import { createPreviewDataUrl, formatHexPreview, getFileExtension, getSftpPreviewDescriptor, type SftpPreviewDescriptor } from '@/lib/sftp/sftp-preview';
import { cn } from '@/lib/utils';
import type { ReadRemoteFileResponse } from '@/types';
import { FileIcon, FileWarningIcon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { SftpDialogBody, SftpDialogContent, SftpDialogHeader } from './sftp-dialog-layout';
import { SftpPreviewOpenControls } from './sftp-preview-file-actions';
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
  textToolbarStart?: React.ReactNode;
  textToolbarEnd?: React.ReactNode;
}

const MediaUnavailable: React.FC = () => {
  const { t } = useI18n();
  return (
    <Alert className="m-auto max-w-md">
      <FileWarningIcon />
      <AlertTitle>{t('sftp.preview.mediaUnavailableTitle')}</AlertTitle>
      <AlertDescription>{t('sftp.preview.mediaUnavailableDescription')}</AlertDescription>
    </Alert>
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

    // The canvas uses p-4, so reserve 16 px on every side before calculating
    // the 100% baseline. Otherwise a fitted image plus its padding overflows
    // the viewport and produces scrollbars even before the user zooms in.
    const viewportWidth = viewportRef.current?.clientWidth ?? 0;
    const viewportHeight = viewportRef.current?.clientHeight ?? 0;
    const availableWidth = viewportWidth > 32 ? viewportWidth - 32 : sourceWidth;
    const availableHeight = viewportHeight > 32 ? viewportHeight - 32 : sourceHeight;
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 items-center justify-end gap-1 border-b px-3">
        <span className="mr-2 font-mono text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
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
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setZoom(1)} disabled={zoom === 1} />}>
            <RotateCcwIcon />
            <span className="sr-only">{t('sftp.preview.resetZoom')}</span>
          </TooltipTrigger>
          <TooltipContent>{t('sftp.preview.resetZoom')}</TooltipContent>
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
      </div>
      <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1 bg-muted/35" horizontal size="thin">
        <div className="grid min-h-full w-max min-w-full place-items-center p-4">
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
      </ScrollArea>
    </div>
  );
};

const MediaPreview: React.FC<{ dataUrl: string; kind: 'audio' | 'video'; name: string }> = ({ dataUrl, kind, name }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [dataUrl]);
  if (failed) return <MediaUnavailable />;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/35 p-8">
      {kind === 'audio' ? (
        <div className="flex w-full max-w-xl flex-col items-center gap-6 rounded-xl border bg-background p-8 shadow-sm">
          <AudioArtwork />
          <p className="max-w-full truncate text-sm font-medium">{name}</p>
          <audio className="w-full" controls src={dataUrl} onError={() => setFailed(true)} />
        </div>
      ) : (
        <video className="max-h-full max-w-full rounded-lg bg-black shadow-sm" controls src={dataUrl} onError={() => setFailed(true)} />
      )}
    </div>
  );
};

const AudioArtwork: React.FC = () => (
  <div className="flex size-24 items-center justify-center rounded-full bg-primary/10 text-primary">
    <span className="text-4xl" aria-hidden="true">
      ♫
    </span>
  </div>
);

const BinaryPreview: React.FC<{ content: string; isArchive: boolean }> = ({ content, isArchive }) => {
  const { t } = useI18n();
  const hex = useMemo(() => formatHexPreview(content), [content]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert className="m-3 w-fit max-w-[calc(100%-1.5rem)] self-start rounded-md">
        <FileWarningIcon />
        <AlertTitle>{isArchive ? t('sftp.preview.archiveTitle') : t('sftp.preview.binaryTitle')}</AlertTitle>
        <AlertDescription>{t('sftp.preview.hexDescription')}</AlertDescription>
      </Alert>
      <ScrollArea className="min-h-0 flex-1" horizontal size="thin">
        <pre className="w-max min-w-full px-4 pb-4 font-mono text-xs leading-5 text-muted-foreground">{hex}</pre>
      </ScrollArea>
    </div>
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
    <ScrollArea className="min-h-0 flex-1 bg-muted/35" size="thin">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 p-8" style={{ fontFamily: family }}>
        <p className="text-xs text-muted-foreground">{family ? t('sftp.preview.fontLoaded') : t('sftp.preview.fontLoading')}</p>
        <p className="text-6xl leading-tight">Aa 字</p>
        <p className="text-3xl leading-relaxed">The quick brown fox jumps over the lazy dog.</p>
        <p className="text-3xl leading-relaxed">天地玄黄，宇宙洪荒。你好，世界。</p>
        <p className="text-2xl tracking-wide">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>
        <p className="text-2xl tracking-wide">abcdefghijklmnopqrstuvwxyz</p>
        <p className="text-2xl tracking-wide">0123456789 !@#$%^&amp;*()</p>
      </div>
    </ScrollArea>
  );
};

const PreviewRenderer: React.FC<PreviewRendererProps> = ({ content, descriptor, textToolbarStart, textToolbarEnd }) => {
  const { t } = useI18n();
  if (descriptor.kind === 'unavailable') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Alert className="max-w-md">
          <FileWarningIcon />
          <AlertTitle>{t('sftp.preview.tooLargeTitle')}</AlertTitle>
          <AlertDescription>{t('sftp.preview.tooLargeDescription')}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (descriptor.kind === 'text') return <PlainTextPreview content={content.content} fileName={content.name} toolbarStart={textToolbarStart} toolbarEnd={textToolbarEnd} />;
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
    return <iframe className="min-h-0 w-full flex-1 bg-muted/35" src={dataUrl} title={content.name} />;
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
  const inlineTextToolbar = descriptor?.kind === 'text';
  const isPartial = resolvedContent?.truncated && resolvedContent.contentEncoding !== 'none';
  const metadata = (
    <div
      data-slot="sftp-preview-metadata"
      className={cn(
        'items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground',
        isPartial ? 'grid min-w-min grid-cols-[minmax(0,max-content)_max-content]' : 'flex min-w-0',
      )}
    >
      <span
        data-slot="sftp-preview-metadata-values"
        className="min-w-0 truncate"
        title={formattedSize ? `${extensionLabel} · ${formattedSize}` : extensionLabel}
      >
        <span>{extensionLabel}</span>
        {formattedSize !== undefined && (
          <>
            <span className="mx-2" aria-hidden="true">·</span>
            <span>{formattedSize}</span>
          </>
        )}
      </span>
      {isPartial && <Badge variant="outline">{t('sftp.preview.partial')}</Badge>}
    </div>
  );
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
      <SftpDialogContent className="h-[90vh] max-h-[calc(100vh-2rem)] max-w-6xl">
        <SftpDialogHeader
          title={
            <span className="flex min-w-0 items-center gap-1">
              <FileTypeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger render={<span className="truncate" />}>{displayTarget.name}</TooltipTrigger>
                <TooltipContent className="max-w-sm break-all">{displayTarget.name}</TooltipContent>
              </Tooltip>
            </span>
          }
          description={displayTarget.path}
        />
        <SftpDialogBody className="min-h-0 flex-1 gap-0 overflow-hidden p-0">
          {!inlineTextToolbar && (
            <>
              <div className="flex min-h-11 items-center gap-2 px-3">
                {metadata}
                <div className="ml-auto">{fileActionControls}</div>
              </div>
              <Separator />
            </>
          )}
          {loading ? (
            <div
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-center"
              role="status"
              aria-live="polite"
            >
              <Spinner className="text-primary" size={24} />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('sftp.preview.loading')}</p>
                <p className="text-xs text-muted-foreground">{t('sftp.preview.loadingDescription')}</p>
              </div>
            </div>
          ) : (
            <PreviewRenderer
              content={resolvedContent!}
              descriptor={descriptor!}
              textToolbarStart={inlineTextToolbar ? metadata : undefined}
              textToolbarEnd={inlineTextToolbar ? fileActionControls : undefined}
            />
          )}
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
