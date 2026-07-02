import { useCallback, useEffect, useRef, useState } from 'react';

export function useDelayedHover(enterDelay = 200, leaveDelay = 150) {
  const [hovered, setHovered] = useState(false);
  const enterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
    if (hovered || enterTimeoutRef.current) return;
    enterTimeoutRef.current = setTimeout(() => {
      setHovered(true);
    }, enterDelay);
  }, [enterDelay, hovered]);

  const onMouseLeave = useCallback(() => {
    if (enterTimeoutRef.current) {
      clearTimeout(enterTimeoutRef.current);
      enterTimeoutRef.current = null;
    }
    if (leaveTimeoutRef.current) return;
    leaveTimeoutRef.current = setTimeout(() => {
      setHovered(false);
    }, leaveDelay);
  }, [leaveDelay]);

  useEffect(() => {
    return () => {
      if (enterTimeoutRef.current) {
        clearTimeout(enterTimeoutRef.current);
      }
      if (leaveTimeoutRef.current) {
        clearTimeout(leaveTimeoutRef.current);
      }
    };
  }, []);

  return { hovered, onMouseEnter, onMouseLeave };
}
