import { parser, GFM } from '@lezer/markdown';
import { $getRoot, $isElementNode, $isTextNode, type LexicalEditor, type LexicalNode } from 'lexical';

export type MarkdownHighlightKind = 'heading' | 'emphasis' | 'code' | 'link' | 'marker' | 'quote' | 'strike';
export interface MarkdownSpan { readonly from: number; readonly to: number; readonly kind: MarkdownHighlightKind }
const markdownParser = parser.configure(GFM);
const kinds: readonly MarkdownHighlightKind[] = ['heading', 'emphasis', 'code', 'link', 'marker', 'quote', 'strike'];

/** Parse source positions without converting, escaping, or executing its contents. */
export function markdownSpans(source: string): readonly MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  markdownParser.parse(source).iterate({ enter(node) {
    let kind: MarkdownHighlightKind | undefined;
    if (/^(?:ATX|Setext)Heading/u.test(node.name)) kind = 'heading';
    else if (node.name === 'Emphasis' || node.name === 'StrongEmphasis') kind = 'emphasis';
    else if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) kind = 'code';
    else if (['Link', 'Autolink', 'URL'].includes(node.name)) kind = 'link';
    else if (['ListMark', 'QuoteMark', 'HeaderMark', 'TaskMarker', 'TableDelimiter'].includes(node.name)) kind = 'marker';
    else if (node.name === 'Blockquote') kind = 'quote';
    else if (node.name === 'Strikethrough') kind = 'strike';
    if (kind) spans.push({ from: node.from, to: node.to, kind });
    // Markdown-looking text inside code remains literal code.
    if (kind === 'code') return false;
  } });
  return spans;
}

const owners = new Map<HTMLElement, ReadonlyMap<MarkdownHighlightKind, readonly Range[]>>();
function publishHighlights() {
  if (typeof Highlight === 'undefined' || typeof CSS === 'undefined' || !CSS.highlights) return;
  for (const kind of kinds) {
    const ranges = [...owners.values()].flatMap(owner => owner.get(kind) ?? []);
    const name = `ai-composer-md-${kind}`;
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  }
}

/** Native highlights leave Lexical's text, selection, undo history and tokens intact. */
export function createComposerMarkdown() {
  let source: string | undefined;
  let spans: readonly MarkdownSpan[] = [];
  let root: HTMLElement | null = null;
  const read = (next: string) => {
    if (source !== next) { source = next; spans = markdownSpans(next); }
    return spans;
  };
  return {
    read,
    paint(editor: LexicalEditor) {
      if (typeof Highlight === 'undefined' || typeof CSS === 'undefined' || !CSS.highlights) return;
      root = editor.getRootElement();
      if (!root) return;
      const ranges = new Map<MarkdownHighlightKind, Range[]>();
      const current = read($getRoot().getTextContent());
      let offset = 0;
      const visit = (node: LexicalNode) => {
        if ($isElementNode(node)) { node.getChildren().forEach(visit); return; }
        const length = node.getTextContentSize();
        if ($isTextNode(node) && node.isSimpleText()) {
          const element = editor.getElementByKey(node.getKey());
          const text = element?.firstChild;
          if (element && text?.nodeType === Node.TEXT_NODE) for (const span of current) {
            const start = Math.max(span.from, offset), end = Math.min(span.to, offset + length);
            if (start >= end) continue;
            const range = element.ownerDocument.createRange();
            range.setStart(text, start - offset); range.setEnd(text, end - offset);
            const group = ranges.get(span.kind) ?? [];
            group.push(range); ranges.set(span.kind, group);
          }
        }
        offset += length;
      };
      visit($getRoot());
      owners.set(root, ranges);
      publishHighlights();
    },
    dispose() {
      if (root) owners.delete(root);
      root = null;
      publishHighlights();
    },
  };
}
