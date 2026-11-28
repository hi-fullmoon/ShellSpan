/** Measure the current controls in their natural layout before choosing a compact stage. */
export function observeComposerToolbar(toolbar: HTMLElement): () => void {
  let frame = 0;
  let disposed = false;
  const update = () => {
    toolbar.dataset.measuring = '';
    const style = getComputedStyle(toolbar);
    const available = toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const groups = Array.from(toolbar.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
    for (const stage of ['full', 'model', 'surface', 'permission']) {
      toolbar.dataset.compact = stage;
      const required = groups.reduce((sum, group) => sum + group.getBoundingClientRect().width, 0)
        + Math.max(0, groups.length - 1) * parseFloat(style.columnGap || '0');
      if (required <= available + 0.5) break;
    }
    delete toolbar.dataset.measuring;
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(toolbar);
  const mutations = new MutationObserver(schedule);
  mutations.observe(toolbar, { childList: true, characterData: true, subtree: true });
  void document.fonts?.ready.then(() => { if (!disposed) schedule(); });
  update();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
  };
}
