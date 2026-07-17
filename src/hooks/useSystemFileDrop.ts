import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DragDropEvent } from '@tauri-apps/api/window';
import type { Event as TauriEvent, UnlistenFn } from '@tauri-apps/api/event';

export interface UseSystemFileDropOptions {
  leftPaneRef: React.RefObject<HTMLElement | null>;
  rightPaneRef: React.RefObject<HTMLElement | null>;
  onDrop: (paths: string[], side: 'local' | 'remote') => void;
  canDrop?: (side: 'local' | 'remote') => boolean;
}

export interface UseSystemFileDropResult {
  dragActive: boolean;
  hoveredSide: 'local' | 'remote' | null;
}

export function useSystemFileDrop(options: UseSystemFileDropOptions): UseSystemFileDropResult {
  const [dragActive, setDragActive] = useState(false);
  const [hoveredSide, setHoveredSide] = useState<'local' | 'remote' | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const window = getCurrentWindow();
      unlisten = await window.onDragDropEvent((event: TauriEvent<DragDropEvent>) => {
        if (cancelled) return;
        const { payload } = event;
        switch (payload.type) {
          case 'enter':
          case 'over': {
            setDragActive(true);
            const side = resolveSideFromPosition(
              payload.position,
              optionsRef.current.leftPaneRef.current,
              optionsRef.current.rightPaneRef.current,
            );
            setHoveredSide(side);
            break;
          }
          case 'leave': {
            setDragActive(false);
            setHoveredSide(null);
            break;
          }
          case 'drop': {
            setDragActive(false);
            setHoveredSide(null);
            const side = resolveSideFromPosition(
              payload.position,
              optionsRef.current.leftPaneRef.current,
              optionsRef.current.rightPaneRef.current,
            );
            if (side && (!optionsRef.current.canDrop || optionsRef.current.canDrop(side))) {
              optionsRef.current.onDrop(payload.paths, side);
            }
            break;
          }
        }
      });
    };

    void attach();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { dragActive, hoveredSide };
}

function resolveSideFromPosition(
  position: { x: number; y: number },
  leftPane: HTMLElement | null,
  rightPane: HTMLElement | null,
): 'local' | 'remote' | null {
  const leftRect = leftPane?.getBoundingClientRect();
  const rightRect = rightPane?.getBoundingClientRect();
  if (leftRect && containsPoint(leftRect, position)) return 'local';
  if (rightRect && containsPoint(rightRect, position)) return 'remote';
  return null;
}

function containsPoint(rect: DOMRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}
