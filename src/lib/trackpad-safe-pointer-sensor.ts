import { PointerSensor } from '@dnd-kit/core';
import type { PointerSensorProps, SensorInstance } from '@dnd-kit/core';

// AbstractPointerSensor declares handleMove/handleEnd as private in its
// .d.ts, but at runtime they are prototype methods bound to the instance in
// the constructor — a subclass override is picked up by that binding. The
// cast re-exposes them with a structural type so TypeScript lets us
// override them (intersecting with PointerSensor itself collapses to never
// because of the private members).
interface PointerSensorInternals extends SensorInstance {
  handleMove(event: globalThis.PointerEvent): void;
  handleEnd(event: globalThis.PointerEvent): void;
}

const PointerSensorBase = PointerSensor as unknown as (new (
  props: PointerSensorProps,
) => PointerSensorInternals) & {
  activators: typeof PointerSensor.activators;
};

/**
 * PointerSensor that treats a mouse move with no button held as a release.
 *
 * With macOS tap-to-click (light trackpad tap) in WKWebView the pointerup
 * can go missing. The pending sensor then survives the tap and turns the
 * next mouse move past the activation distance into an unintended drag.
 * A move event reporting `buttons === 0` proves the pointer was released,
 * so end the interaction instead of starting a drag.
 */
export class TrackpadSafePointerSensor extends PointerSensorBase {
  override handleMove(event: globalThis.PointerEvent): void {
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      this.handleEnd(event);
      return;
    }
    super.handleMove(event);
  }
}
