// Capture jsdom's native canvas integration before shared test setup installs
// its no-canvas fallback. Terminal suites opt into real drawing locally.
const getContext = HTMLCanvasElement.prototype.getContext;

export function enableRealCanvas(): () => void {
  const previous = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: getContext,
  });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', previous);
}
