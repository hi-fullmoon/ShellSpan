import { useCallback, useEffect, useRef } from 'react';

/**
 * Makes discrete desktop navigation actions resilient to WKWebView dropping a
 * trackpad tap event. macOS tap-to-click can occasionally omit pointerdown on
 * a rapid subsequent tap, even though pointerup still reaches the target.
 *
 * Pointer interactions activate as soon as they begin, so an omitted native
 * click cannot leave the UI unchanged. Keyboard activation continues to use
 * click, preserving the button's normal accessibility behavior.
 */
export function useTrackpadSafeActivation(onActivate: () => void): {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
} {
  const pressedPointerIdRef = useRef<number | null>(null);
  const pointerActivationPendingClickRef = useRef(false);
  const pendingClickResetTimerRef = useRef<number | null>(null);

  const clearPendingClick = useCallback((): void => {
    if (pendingClickResetTimerRef.current !== null) {
      window.clearTimeout(pendingClickResetTimerRef.current);
      pendingClickResetTimerRef.current = null;
    }
    pointerActivationPendingClickRef.current = false;
  }, []);

  const schedulePendingClickReset = useCallback((): void => {
    if (pendingClickResetTimerRef.current !== null) {
      window.clearTimeout(pendingClickResetTimerRef.current);
    }
    pendingClickResetTimerRef.current = window.setTimeout(() => {
      pendingClickResetTimerRef.current = null;
      pointerActivationPendingClickRef.current = false;
    }, 0);
  }, []);

  useEffect(() => clearPendingClick, [clearPendingClick]);

  const activateFromPointer = useCallback((): void => {
    pointerActivationPendingClickRef.current = true;
    onActivate();
  }, [onActivate]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    pressedPointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort in WKWebView.
    }
    activateFromPointer();
  }, [activateFromPointer]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    // If this element did not receive the corresponding pointerdown, this is
    // the WKWebView trackpad-tap case. The release is still a valid activation.
    if (pressedPointerIdRef.current !== event.pointerId) {
      activateFromPointer();
    }
    pressedPointerIdRef.current = null;
    schedulePendingClickReset();
  }, [activateFromPointer, schedulePendingClickReset]);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (
      pressedPointerIdRef.current !== null
      && pressedPointerIdRef.current !== event.pointerId
    ) return;
    pressedPointerIdRef.current = null;
    clearPendingClick();
  }, [clearPendingClick]);

  const onClick = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    // Pointer clicks normally follow pointerdown/pointerup. They have a
    // positive detail value, while keyboard-synthesized clicks use 0.
    if (event.detail > 0 && pointerActivationPendingClickRef.current) {
      clearPendingClick();
      return;
    }
    clearPendingClick();
    onActivate();
  }, [clearPendingClick, onActivate]);

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}
