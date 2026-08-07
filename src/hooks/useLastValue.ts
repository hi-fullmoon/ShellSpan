import { useState } from 'react';

/**
 * Returns the most recent non-undefined value.
 *
 * Data-driven dialogs derive both `open` and their content from a single
 * payload (e.g. `open={target !== undefined}`). When the parent clears the
 * payload on close, `open` flips to false at the same moment the content is
 * dropped, which cuts off the exit animation or collapses the dialog layout
 * mid-fade. Keeping the last value around lets the dialog render stable
 * content while it fades out; the snapshot is refreshed as soon as a new
 * payload arrives.
 *
 * The snapshot is synced during render (not in an effect) so a dialog that
 * reopens with new content never flashes the previously-closed payload for a
 * frame — React re-renders before committing, so the DOM never shows the stale
 * value. The `value !== snapshot` guard keeps this from looping when the value
 * is a stable reference while open.
 */
export function useLastValue<T>(value: T | undefined): T | undefined {
  const [snapshot, setSnapshot] = useState<T | undefined>(value);

  if (value !== undefined && value !== snapshot) {
    setSnapshot(value);
  }

  return snapshot;
}
