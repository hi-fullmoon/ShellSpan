import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContextMenuStore } from '../stores/contextMenuStore';

export interface MenuPosition {
  x: number;
  y: number;
}

export interface UseContextMenuReturn {
  isOpen: boolean;
  position: MenuPosition | null;
  open: (x: number, y: number) => void;
  close: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}

export function useContextMenu(menuId: string): UseContextMenuReturn {
  const { activeMenuId, openMenu, closeMenu } = useContextMenuStore();
  const isOpen = activeMenuId === menuId;
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const open = useCallback(
    (x: number, y: number) => {
      setPosition({ x, y });
      openMenu(menuId);
    },
    [menuId, openMenu],
  );

  const close = useCallback(() => {
    closeMenu();
    setPosition(null);
  }, [closeMenu]);

  // Sync: clear position when this menu is no longer active
  useEffect(() => {
    if (!isOpen && position !== null) {
      setPosition(null);
    }
  }, [isOpen]);

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        close();
      }
    };

    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [isOpen, close]);

  // Position clamping
  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const edge = 8;
    const nextX = Math.max(edge, Math.min(position.x, window.innerWidth - rect.width - edge));
    const nextY = Math.max(edge, Math.min(position.y, window.innerHeight - rect.height - edge));

    if (nextX !== position.x || nextY !== position.y) {
      setPosition({ x: nextX, y: nextY });
    }
  }, [position]);

  return { isOpen, position, open, close, menuRef };
}
