import userEvent from '@testing-library/user-event';
import { act, fireEvent } from '@testing-library/react';

/** Select UTF-16 text offsets through the browser Selection API. */
export function selectEditorText(element: HTMLElement, start: number, end = start) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const point = (offset: number): [Node, number] => {
    for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; }
    return [element, element.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(start)); range.setEnd(...point(end));
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  fireEvent(document, new Event('selectionchange'));
}

/** jsdom does not implement native contenteditable typing; paste uses Lexical's real insertion path. */
export default {
  ...userEvent,
  setup(...args: Parameters<typeof userEvent.setup>) {
    const user = userEvent.setup(...args);
    return {
      ...user,
      async type(element: Element, text: string, options?: Parameters<typeof user.type>[2]) {
        if (!element.hasAttribute('data-composer-editor')) return user.type(element, text, options);
        await user.click(element);
        await user.paste(text);
      },
      async clear(element: Element) {
        if (!element.hasAttribute('data-composer-editor')) return user.clear(element);
        await user.click(element);
        await act(async () => selectEditorText(element as HTMLElement, 0, element.textContent?.length ?? 0));
        await user.keyboard('{Backspace}');
      },
    };
  },
};
