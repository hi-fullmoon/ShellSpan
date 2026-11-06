interface ViewportRect { left: number; top: number; right: number; bottom: number; width: number; height: number }

export function createNativePackageHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.style.cssText = 'width:100vw;height:100vh';
  (document.getElementById('root') ?? document.body).append(host);
  return host;
}

export function nativePackageViewport(host: HTMLElement, terminal?: HTMLElement | null): {host: ViewportRect; terminal: ViewportRect | null; width: number; height: number} {
  const read = (element: HTMLElement): ViewportRect => {
    const {left, top, right, bottom, width, height} = element.getBoundingClientRect();
    if (!(width > 0 && height > 0 && left >= -1 && top >= -1 && right <= innerWidth + 1 && bottom <= innerHeight + 1)) {
      throw new Error('Installed ordinary terminal is outside the actual viewport');
    }
    return {left, top, right, bottom, width, height};
  };
  return {host: read(host), terminal: terminal ? read(terminal) : null, width: innerWidth, height: innerHeight};
}
