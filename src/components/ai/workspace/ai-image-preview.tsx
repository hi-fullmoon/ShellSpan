import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const INITIAL_VIEW = { zoom: 100, x: 0, y: 0 };
type View = typeof INITIAL_VIEW;

type PreviewImage = { id: string; source?: string; name: string };
const GalleryContext = createContext<{
  images: readonly PreviewImage[];
  register: (image: PreviewImage) => void;
  unregister: (id: string) => void;
} | null>(null);

export function AiImagePreviewGroup({ children }: { children: ReactNode }) {
  const [images, setImages] = useState<PreviewImage[]>([]);
  const register = useCallback((image: PreviewImage) => setImages(previous => {
    const index = previous.findIndex(item => item.id === image.id);
    if (index < 0) return [...previous, image];
    if (previous[index].source === image.source && previous[index].name === image.name) return previous;
    return previous.map(item => item.id === image.id ? image : item);
  }), []);
  const unregister = useCallback((id: string) => setImages(previous => previous.filter(item => item.id !== id)), []);
  return <GalleryContext value={{ images, register, unregister }}>{children}</GalleryContext>;
}

function ImagePreviewContent({ source, name, imageId, onClose, index, count, onNavigate }: {
  source: string; name: string; onClose: () => void;
  imageId: string;
  index: number; count: number; onNavigate: (direction: number) => void;
}) {
  const { t } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; view: View } | null>(null);
  const [view, setView] = useState(INITIAL_VIEW);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    setView(INITIAL_VIEW);
    setStatus(picture.current?.complete && picture.current.naturalWidth > 0 ? 'ready' : 'loading');
    setDragging(false);
    drag.current = null;
  }, [source, imageId]);

  const clampView = (next: View): View => {
    if (!stage.current || !picture.current) return next;
    const maxX = Math.max(0, (picture.current.clientWidth * next.zoom / 100 - stage.current.clientWidth) / 2);
    const maxY = Math.max(0, (picture.current.clientHeight * next.zoom / 100 - stage.current.clientHeight) / 2);
    return { ...next, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  };
  const zoomBy = (amount: number) => setView(previous => clampView({ ...previous, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, previous.zoom + amount)) }));
  const reset = () => setView(INITIAL_VIEW);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(() => setView(previous => clampView(previous)));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  return <DialogContent variant="image-preview" showCloseButton={false} initialFocus={closeButton}
    onClick={event => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
    }}
    onKeyDown={event => {
      // Keep modal shortcuts out of the composer and terminal underneath it.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (count > 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        onNavigate(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (status !== 'ready' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(25); }
      if (event.key === '-') { event.preventDefault(); zoomBy(-25); }
      if (event.key === '0') { event.preventDefault(); reset(); }
      const step = 40;
      const direction = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
      if (direction) {
        event.preventDefault();
        setView(previous => clampView({ ...previous, x: previous.x + direction[0], y: previous.y + direction[1] }));
      }
    }}>
    <DialogTitle className="sr-only">{name}</DialogTitle>
    <DialogDescription className="sr-only">{t('ai.workspace.images.previewHint')}</DialogDescription>
    <div ref={stage} className="image-preview-stage" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      {status === 'loading' && <Spinner className="absolute motion-reduce:animate-none" />}
      {status === 'error' && <p role="status">{t('ai.workspace.images.error.blob')}</p>}
      <img key={`${imageId}:${source}`} ref={picture} src={source} alt={name} draggable={false}
        className="image-preview-picture" data-status={status} data-zoomed={view.zoom > 100} data-dragging={dragging}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom / 100})` }}
        onLoad={() => setStatus('ready')} onError={() => setStatus('error')}
        onDoubleClick={() => view.zoom === 100 ? zoomBy(100) : reset()}
        onPointerDown={event => {
          if (event.button !== 0 || view.zoom <= 100) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
          setDragging(true);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          setView(clampView({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y }));
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      />
    </div>
    <div className="image-preview-actions">
      <DialogClose render={<Button ref={closeButton} variant="secondary" size="icon" className="size-11 rounded-full" aria-label={t('common.close')} />}><XIcon /></DialogClose>
    </div>
    {count > 1 && <>
      <Button variant="secondary" size="icon" className="absolute top-1/2 left-3 size-10 -translate-y-1/2 rounded-full" aria-label={t('ai.workspace.images.previousImage')} disabled={index === 0} onClick={() => onNavigate(-1)}><ChevronLeftIcon /></Button>
      <Button variant="secondary" size="icon" className="absolute top-1/2 right-3 size-10 -translate-y-1/2 rounded-full" aria-label={t('ai.workspace.images.nextImage')} disabled={index === count - 1} onClick={() => onNavigate(1)}><ChevronRightIcon /></Button>
      <span className="absolute top-5 left-1/2 -translate-x-1/2 tabular-nums" role="status" aria-live="polite" aria-label={t('ai.workspace.images.position', { current: index + 1, total: count })}>{index + 1} / {count}</span>
    </>}
    <div className="image-preview-zoom" role="group" aria-label={t('ai.workspace.images.zoom')}>
      <Button variant="secondary" size="icon" className="size-10 rounded-full" aria-label={t('ai.workspace.images.zoomOut')} disabled={status !== 'ready' || view.zoom <= MIN_ZOOM} onClick={() => zoomBy(-25)}><MinusIcon /></Button>
      <Button variant="plain" className="min-w-16 rounded-full tabular-nums" aria-label={t('ai.workspace.images.resetZoom')} disabled={status !== 'ready'} onClick={reset}>
        <span aria-live="polite" aria-atomic="true">{view.zoom}%</span>
      </Button>
      <Button variant="secondary" size="icon" className="size-10 rounded-full" aria-label={t('ai.workspace.images.zoomIn')} disabled={status !== 'ready' || view.zoom >= MAX_ZOOM} onClick={() => zoomBy(25)}><PlusIcon /></Button>
    </div>
  </DialogContent>;
}

export function AiImagePreview({ source, name, children }: { source?: string; name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const gallery = useContext(GalleryContext);
  const register = gallery?.register;
  const unregister = gallery?.unregister;
  const [selectedId, setSelectedId] = useState(id);
  useEffect(() => { register?.({ id, source, name }); }, [register, id, source, name]);
  useEffect(() => () => unregister?.(id), [unregister, id]);
  const images = gallery?.images.filter(image => image.source) ?? [{ id, source, name }];
  const selectedIndex = images.findIndex(image => image.id === selectedId);
  const index = selectedIndex >= 0 ? selectedIndex : Math.max(0, images.findIndex(image => image.id === id));
  const selected = images[index];
  return <Dialog open={open && Boolean(selected?.source)} onOpenChange={value => { if (value) setSelectedId(id); setOpen(value); }}>
    {children}
    {open && selected?.source && <ImagePreviewContent source={selected.source} name={selected.name} imageId={selected.id} onClose={() => setOpen(false)}
      index={index} count={images.length} onNavigate={direction => {
        const next = images[index + direction];
        if (next) setSelectedId(next.id);
      }} />}
  </Dialog>;
}
