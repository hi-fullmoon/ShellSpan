import { useEffect } from 'react';

export function useDisableContextMenu(): void {
  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    document.addEventListener('contextmenu', preventNativeContextMenu, true);
    return () => {
      document.removeEventListener('contextmenu', preventNativeContextMenu, true);
    };
  }, []);
}
