import { useEffect, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

const enabledAction = '[role="menuitem"]:not([disabled])';
const enabledItem = `${enabledAction}, [role="menuitemradio"]:not([disabled])`;

export function useContextMenuNavigation(
  menuRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  targetId?: string,
) {
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;

    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => {
      menu.querySelector<HTMLElement>(enabledAction)?.focus({ preventScroll: true });
    });

    return () => {
      cancelAnimationFrame(frame);
      const active = document.activeElement;
      if (previous instanceof HTMLElement && previous.isConnected &&
        (active === document.body || menu.contains(active))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [menuRef, open, targetId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(enabledItem));
    if (items.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.findIndex(item => item === document.activeElement);
    let nextIndex: number;
    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    } else {
      nextIndex = (currentIndex + 1) % items.length;
    }
    items[nextIndex].focus();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLElement>(enabledAction);
    if (item && item !== document.activeElement && event.currentTarget.contains(item)) {
      item.focus({ preventScroll: true });
    }
  };

  return { onKeyDown, onPointerMove };
}
