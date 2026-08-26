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
import { formatSize } from '@/lib/sftp-utils';
import { createPreviewDataUrl, formatHexPreview, getFileExtension, getSftpPreviewDescriptor, type SftpPreviewDescriptor } from '@/lib/sftp-preview';
import { cn } from '@/lib/utils';
import type { ReadRemoteFileResponse } from '@/types';
import { ExternalLinkIcon, FileIcon, FileWarningIcon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { SftpDialogBody, SftpDialogContent, SftpDialogHeader } from './sftp-dialog-layout';
import {
  ArchivePreview,
  MarkdownPreview,
  OfficeDocumentPreview,
  PlainTextPreview,
  StructuredDataPreview,
} from './sftp-rich-preview';

export interface SftpPreviewDialogProps {
  target?: {
    path: string;
    name: string;
    size?: number;
  };
  content?: ReadRemoteFileResponse;
  open: boolean;
  onClose: () => void;
  onOpenExternally?: (path: string) => void;
}

interface PreviewRendererProps {
  content: ReadRemoteFileResponse;
  descriptor: SftpPreviewDescriptor;
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
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
          disabled={zoom <= 0.25}
        >
          <ZoomOutIcon />
          <span className="sr-only">{t('sftp.preview.zoomOut')}</span>
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom(1)} disabled={zoom === 1}>
          <RotateCcwIcon />
          <span className="sr-only">{t('sftp.preview.resetZoom')}</span>
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom((value) => Math.min(4, value + 0.25))} disabled={zoom >= 4}>
          <ZoomInIcon />
          <span className="sr-only">{t('sftp.preview.zoomIn')}</span>
        </Button>
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
    const familyName = `TermBridgePreview-${Date.now().toString(36)}`;
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

const PreviewRenderer: React.FC<PreviewRendererProps> = ({ content, descriptor }) => {
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
  if (descriptor.kind === 'text') return <PlainTextPreview content={content.content} />;
  if (descriptor.kind === 'markdown') return <MarkdownPreview content={content.content} />;
  if (descriptor.kind === 'data') return <StructuredDataPreview content={content.content} extension={descriptor.extension} />;
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
    return <iframe className="min-h-0 flex-1 bg-muted/35" src={dataUrl} title={content.name} />;
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

export const SftpPreviewDialog: React.FC<SftpPreviewDialogProps> = ({ target, content, open, onClose, onOpenExternally }) => {
  const { t } = useI18n();
  const liveTarget = useMemo(
    () => target ?? (content ? { path: content.path, name: content.name, size: content.size } : undefined),
    [content, target],
  );
  const displayTarget = useLastValue(liveTarget);
  const displayContent = useLastValue(content);
  const loading = target !== undefined && content === undefined;
  const resolvedContent = loading ? undefined : displayContent;
  const descriptor = useMemo(
    () => (resolvedContent ? getSftpPreviewDescriptor(resolvedContent.name, resolvedContent.contentEncoding) : undefined),
    [resolvedContent],
  );

  if (!displayTarget || (!loading && (!resolvedContent || !descriptor))) return null;
  const FileTypeIcon = descriptor?.icon ?? FileIcon;
  const kindLabel = descriptor ? t(`sftp.preview.kind.${descriptor.kind}`) : t('sftp.preview.loading');
  const extension = descriptor?.extension ?? getFileExtension(displayTarget.name);
  const extensionLabel = extension ? extension.toUpperCase() : t('sftp.preview.kind.unavailable');
  const displaySize = resolvedContent?.size ?? displayTarget.size;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SftpDialogContent className="h-[min(84vh,780px)] max-w-5xl grid-rows-[auto_minmax(0,1fr)]">
        <SftpDialogHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <FileTypeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger render={<span className="truncate" />}>{displayTarget.name}</TooltipTrigger>
                <TooltipContent className="max-w-sm break-all">{displayTarget.name}</TooltipContent>
              </Tooltip>
            </span>
          }
          description={displayTarget.path}
        />
        <SftpDialogBody className="min-h-0 gap-0 overflow-hidden p-0">
          <div className="flex min-h-11 items-center gap-2 px-3">
            <Badge variant="secondary">{extensionLabel}</Badge>
            <span className="text-xs text-muted-foreground">{kindLabel}</span>
            {displaySize !== undefined && (
              <>
                <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />
                <span className="font-mono text-xs text-muted-foreground">{formatSize(Number(displaySize))}</span>
              </>
            )}
            {resolvedContent?.truncated && resolvedContent.contentEncoding !== 'none' && <Badge variant="outline">{t('sftp.preview.partial')}</Badge>}
            <div className="ml-auto">
              {onOpenExternally && (
                <Button variant="outline" size="sm" onClick={() => onOpenExternally(displayTarget.path)}>
                  <ExternalLinkIcon data-icon="inline-start" />
                  {t('sftp.preview.openExternally')}
                </Button>
              )}
            </div>
          </div>
          <Separator />
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
            <PreviewRenderer content={resolvedContent!} descriptor={descriptor!} />
          )}
        </SftpDialogBody>
      </SftpDialogContent>
    </Dialog>
  );
};
