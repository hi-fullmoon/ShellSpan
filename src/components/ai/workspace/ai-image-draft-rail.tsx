import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentActions, AttachmentAction, AttachmentTrigger } from '@/components/ui/attachment';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/hooks/useI18n';
import type { AgentImageUpload } from '@/types/agent-image';

function PendingImage({ file }: { file: File }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <Attachment orientation="vertical" className="ai-image-thumbnail" state="processing" aria-busy="true">
    <AttachmentMedia variant="image" className="ai-image-thumbnail-media">
      <Skeleton className="absolute inset-0 size-full motion-reduce:animate-none" />
      {source && <img className="relative" src={source} alt={file.name} />}
    </AttachmentMedia>
    <span className="ai-image-thumbnail-loading" aria-hidden="true"><Spinner className="motion-reduce:animate-none" /></span>
  </Attachment>;
}

export function AiImageDraftRail({ images, pendingFiles = [], busy, locked, error, onRemove }: {
  images: readonly AgentImageUpload[]; busy: boolean; locked: boolean; error: boolean;
  pendingFiles?: readonly File[];
  onRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  const rail = useRef<HTMLDivElement>(null);
  const count = images.length + pendingFiles.length;
  const previousCount = useRef(count);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const element = rail.current;
    if (!element) return;
    const left = element.scrollLeft > 1;
    const right = element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
    setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
  }, []);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    if (count > previousCount.current) element.scrollLeft = element.scrollWidth;
    previousCount.current = count;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    // Vertical mouse wheels pan the thumbnail strip without scrolling the conversation.
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      element.scrollBy({ left: (event.deltaX || event.deltaY) * scale, behavior: 'auto' });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [count, updateEdges]);
  const page = (direction: number) => rail.current?.scrollBy({
    left: direction * Math.max(rail.current.clientWidth - 64, 64),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });

  return <div className="ai-image-rail">
    <AttachmentGroup ref={rail} className="ai-image-rail-viewport" role="group" aria-label={t('ai.workspace.images.attachments')} onScroll={updateEdges}
      onFocusCapture={event => event.target.closest('.ai-image-thumbnail')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })}>
      {images.map((image, index) => {
        const source = `data:${image.mediaType};base64,${image.data}`;
        return <Dialog key={`${index}:${image.name}`}>
          <Attachment orientation="vertical" className="ai-image-thumbnail" state={error ? 'error' : 'done'}>
            <AttachmentMedia variant="image" className="ai-image-thumbnail-media">
              <img src={source} alt={image.name} />
            </AttachmentMedia>
            <DialogTrigger render={<AttachmentTrigger className="ai-image-thumbnail-open" aria-label={`${t('ai.workspace.images.preview')} ${image.name}`} title={image.name} />} />
            <AttachmentActions className="ai-image-thumbnail-actions">
              <AttachmentAction variant="secondary" className="ai-image-thumbnail-remove" aria-label={`${t('ai.workspace.images.remove')} ${image.name}`} disabled={busy || locked} onClick={() => onRemove(index)}><XIcon /></AttachmentAction>
            </AttachmentActions>
          </Attachment>
          <DialogContent className="w-[calc(100vw-32px)] max-w-4xl" onClick={event => event.stopPropagation()}>
            <DialogTitle className="truncate pr-8">{image.name}</DialogTitle>
            <DialogDescription className="sr-only">{t('ai.workspace.images.preview')}</DialogDescription>
            <img className="max-h-[75vh] w-full object-contain" src={source} alt={image.name} />
          </DialogContent>
        </Dialog>;
      })}
      {pendingFiles.map((file, index) => <PendingImage key={`pending:${index}:${file.name}`} file={file} />)}
    </AttachmentGroup>
    {edges.left && <Button variant="secondary" size="icon-xs" className="ai-image-rail-arrow ai-image-rail-previous" aria-label={t('ai.workspace.images.previous')} onClick={() => page(-1)}><ChevronLeftIcon /></Button>}
    {edges.right && <Button variant="secondary" size="icon-xs" className="ai-image-rail-arrow ai-image-rail-next" aria-label={t('ai.workspace.images.next')} onClick={() => page(1)}><ChevronRightIcon /></Button>}
  </div>;
}
