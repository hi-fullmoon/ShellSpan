import { createContext, useContext, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentActions, AttachmentAction, AttachmentTrigger } from '@/components/ui/attachment';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/hooks/useI18n';
import type { AgentImageUpload } from '@/types/agent-image';
import { AiImagePreview, AiImagePreviewGroup } from './ai-image-preview';

export const UnifiedAttachmentContext = createContext(false);

function PendingImage({ file, onCancel }: { file: File; onCancel?: () => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <AiImagePreview source={source} name={file.name}><Attachment orientation="vertical" className="ai-image-thumbnail isolate size-16 min-w-16 focus-within:ring-0 has-data-[slot=attachment-media]:p-0" state="processing" aria-busy="true">
    <AttachmentMedia variant="image" className="ai-image-thumbnail-media size-full">
      <Skeleton className="absolute inset-0 size-full motion-reduce:animate-none" />
      {source && <img className="relative h-full" src={source} alt={file.name} />}
    </AttachmentMedia>
    {source && <DialogTrigger render={<AttachmentTrigger className="ai-image-thumbnail-open cursor-zoom-in" aria-label={`${t('ai.workspace.images.preview')} ${file.name}`} />} />}
    <span className="ai-image-thumbnail-loading absolute right-1.25 bottom-1.25 grid size-5 place-items-center" aria-hidden="true"><Spinner className="motion-reduce:animate-none" /></span>
    {onCancel && <AttachmentActions className="ai-image-thumbnail-actions absolute group-data-[orientation=vertical]/attachment:top-0.75 group-data-[orientation=vertical]/attachment:right-0.75">
      <AttachmentAction variant="secondary" className="size-5 rounded-full" aria-label={t('common.cancel')} onClick={onCancel}><XIcon /></AttachmentAction>
    </AttachmentActions>}
  </Attachment></AiImagePreview>;
}

export function AiDraftAttachmentRail({ children, count, unified = false }: { children: ReactNode; count: number; unified?: boolean }) {
  const { t } = useI18n();
  const rail = useRef<HTMLDivElement>(null);
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
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateEdges);
    });
    observer.observe(element);
    let cardCount = element.querySelectorAll('[data-slot="attachment"]').length;
    const mutations = new MutationObserver(() => {
      const nextCount = element.querySelectorAll('[data-slot="attachment"]').length;
      if (nextCount > cardCount) element.scrollLeft = element.scrollWidth;
      cardCount = nextCount;
      updateEdges();
    });
    mutations.observe(element, { childList: true, subtree: true });
    // Vertical mouse wheels pan the thumbnail strip while it can still move.
    const wheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      const delta = (event.deltaX || event.deltaY) * scale;
      const next = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta));
      if (next === element.scrollLeft) return;
      event.preventDefault();
      element.scrollLeft = next;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [count, updateEdges]);
  const page = (direction: number) => rail.current?.scrollBy({
    left: direction * Math.max(rail.current.clientWidth - 64, 64),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });

  return <div className="ai-image-rail relative min-w-0 flex-1" data-unified-attachments={unified || undefined}>
    <AttachmentGroup ref={rail} className="ai-image-rail-viewport w-full gap-2 overflow-y-hidden p-0" role="group" aria-label={t(unified ? 'ai.workspace.attachments.attached' : 'ai.workspace.images.attachments')} onScroll={updateEdges}
      onFocusCapture={event => {
        const card = event.target.closest('[data-slot="attachment"]');
        if (!card || !event.currentTarget.contains(card)) return;
        const bounds = card.getBoundingClientRect();
        const viewport = event.currentTarget.getBoundingClientRect();
        if (bounds.left < viewport.left) event.currentTarget.scrollLeft += bounds.left - viewport.left;
        else if (bounds.right > viewport.right) event.currentTarget.scrollLeft += bounds.right - viewport.right;
      }}>
      {children}
    </AttachmentGroup>
    {edges.left && <Button variant="secondary" size="icon-xs" className="ai-image-rail-arrow ai-image-rail-previous absolute top-1/2 left-1 -translate-y-1/2" aria-label={t(unified ? 'ai.workspace.attachments.previous' : 'ai.workspace.images.previous')} onClick={() => page(-1)}><ChevronLeftIcon /></Button>}
    {edges.right && <Button variant="secondary" size="icon-xs" className="ai-image-rail-arrow ai-image-rail-next absolute top-1/2 right-1 -translate-y-1/2" aria-label={t(unified ? 'ai.workspace.attachments.next' : 'ai.workspace.images.next')} onClick={() => page(1)}><ChevronRightIcon /></Button>}
  </div>;
}

export function AiImageDraftRail({ images, pendingFiles = [], busy, locked, error, onRemove, onCancel }: {
  images: readonly AgentImageUpload[]; busy: boolean; locked: boolean; error: boolean;
  pendingFiles?: readonly File[];
  onRemove: (index: number) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const unified = useContext(UnifiedAttachmentContext);
  const cards = <AiImagePreviewGroup>
      {images.map((image, index) => {
        const source = `data:${image.mediaType};base64,${image.data}`;
        return <AiImagePreview key={`${index}:${image.name}`} source={source} name={image.name}>
          <Attachment orientation="vertical" className="ai-image-thumbnail isolate size-16 min-w-16 focus-within:ring-0 has-data-[slot=attachment-media]:p-0" state={error ? 'error' : 'done'}>
            <AttachmentMedia variant="image" className="ai-image-thumbnail-media size-full">
              <img className="h-full" src={source} alt={image.name} />
            </AttachmentMedia>
            <DialogTrigger render={<AttachmentTrigger className="ai-image-thumbnail-open cursor-zoom-in" aria-label={`${t('ai.workspace.images.preview')} ${image.name}`} />} />
            {(onCancel && !pendingFiles.length || !busy && !locked) && <AttachmentActions className="ai-image-thumbnail-actions absolute group-data-[orientation=vertical]/attachment:top-0.75 group-data-[orientation=vertical]/attachment:right-0.75">
              {onCancel && !pendingFiles.length
                ? <AttachmentAction variant="secondary" className="size-5 rounded-full" aria-label={t('common.cancel')} onClick={onCancel}><XIcon /></AttachmentAction>
                : <AttachmentAction variant="secondary" className="ai-image-thumbnail-remove size-5" aria-label={`${t('ai.workspace.images.remove')} ${image.name}`} onClick={() => onRemove(index)}><XIcon /></AttachmentAction>}
            </AttachmentActions>}
          </Attachment>
        </AiImagePreview>;
      })}
      {pendingFiles.map((file, index) => <PendingImage key={`pending:${index}:${file.name}`} file={file} onCancel={onCancel} />)}
  </AiImagePreviewGroup>;
  return unified ? cards : <AiDraftAttachmentRail count={images.length + pendingFiles.length}>{cards}</AiDraftAttachmentRail>;
}
