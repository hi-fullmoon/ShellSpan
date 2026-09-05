import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const INITIAL_VIEW = { zoom: 100, x: 0, y: 0 };
type View = typeof INITIAL_VIEW;

function ImagePreviewContent({ source, name, onClose }: { source: string; name: string; onClose: () => void }) {
  const { t } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; view: View } | null>(null);
  const [view, setView] = useState(INITIAL_VIEW);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);

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
      <img ref={picture} src={source} alt={name} draggable={false}
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
      <DialogClose render={<Button ref={closeButton} variant="secondary" size="icon" className="size-11 rounded-full" aria-label={t('common.close')} title={t('common.close')} />}><XIcon /></DialogClose>
    </div>
    <div className="image-preview-zoom" role="group" aria-label={t('ai.workspace.images.zoom')}>
      <Button variant="secondary" size="icon" className="size-10 rounded-full" aria-label={t('ai.workspace.images.zoomOut')} title={t('ai.workspace.images.zoomOut')} disabled={status !== 'ready' || view.zoom <= MIN_ZOOM} onClick={() => zoomBy(-25)}><MinusIcon /></Button>
      <Button variant="plain" className="min-w-16 rounded-full tabular-nums" aria-label={t('ai.workspace.images.resetZoom')} title={t('ai.workspace.images.resetZoom')} disabled={status !== 'ready'} onClick={reset}>
        <span aria-live="polite" aria-atomic="true">{view.zoom}%</span>
      </Button>
      <Button variant="secondary" size="icon" className="size-10 rounded-full" aria-label={t('ai.workspace.images.zoomIn')} title={t('ai.workspace.images.zoomIn')} disabled={status !== 'ready' || view.zoom >= MAX_ZOOM} onClick={() => zoomBy(25)}><PlusIcon /></Button>
    </div>
  </DialogContent>;
}

export function AiImagePreview({ source, name, children }: { source?: string; name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open && Boolean(source)} onOpenChange={setOpen}>
    {children}
    {open && source && <ImagePreviewContent key={source} source={source} name={name} onClose={() => setOpen(false)} />}
  </Dialog>;
}
