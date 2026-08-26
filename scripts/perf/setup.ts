// jsdom intentionally omits a canvas implementation. The xterm benchmark
// exercises its input parser and buffer without opening a renderer, so a null
// context is sufficient and avoids a noisy jsdom warning during module load.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
