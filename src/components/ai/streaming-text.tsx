/// <reference lib="es2022.intl" />
import { createContext, useContext, useState } from 'react';
import type { ExtraProps } from 'react-markdown';

export const StreamingTextContext = createContext(false);
// Source offsets distinguish newly received blocks from nodes remounted by a
// Markdown reparse (for example when a closing emphasis delimiter arrives).
export const StreamingTextBoundaryContext = createContext(0);

const MAX_FRAGMENTS = 24;
type Fragment = { offset: number; text: string; reveal: boolean; runs: string[] };
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function fragment(text: string, offset: number, reveal: boolean): Fragment {
  const runs: string[] = [];
  if (reveal && segmenter && text.length > 24) {
    const graphemes = Array.from(segmenter.segment(text), (part) => part.segment);
    // At most eight reveal steps, including for a large network burst. Keep
    // complete graphemes and whitespace so selection/copy preserve the text.
    const size = Math.max(6, Math.ceil(graphemes.length / 8));
    for (let index = 0; index < graphemes.length; index += size) {
      runs.push(graphemes.slice(index, index + size).join(''));
    }
  }
  return { text, offset, reveal, runs };
}

function lastGraphemeStart(text: string, from = 0): number {
  let start = from;
  if (segmenter) {
    for (const segment of segmenter.segment(text.slice(from))) start = from + segment.index;
  }
  return start;
}

/** Animate appended text only; a reparse or replacement establishes a new baseline. */
export function StreamingText({ children, sourceStart = 0 }: { children: string; sourceStart?: number }) {
  const streaming = useContext(StreamingTextContext) && segmenter !== null;
  const revealFrom = useContext(StreamingTextBoundaryContext);
  const revealInitial = streaming && sourceStart >= revealFrom && children.length > 0;
  const [state, setState] = useState(() => ({
    text: children,
    prefix: revealInitial ? '' : children,
    fragments: revealInitial ? [fragment(children, 0, true)] : [] as Fragment[],
    streaming,
    tailStart: lastGraphemeStart(children),
  }));

  if (children !== state.text || streaming !== state.streaming) {
    if (children === state.text) {
      // Ending a stream must not replace text nodes: native selections point at
      // these nodes. Existing reveals finish naturally without restarting.
      setState({ ...state, streaming });
    } else if (!state.streaming || !children.startsWith(state.text)) {
      setState({ text: children, prefix: children, fragments: [], streaming, tailStart: lastGraphemeStart(children) });
    } else {
      // Segment only the previous final grapheme plus the new delta. If a delta
      // completes an emoji/combining sequence, keep that sequence in one text node.
      const tail = children.slice(state.tailStart);
      const first = segmenter?.segment(tail)[Symbol.iterator]().next().value;
      const joinsPrevious = state.text.length > 0 && first
        && first.segment.length > state.text.length - state.tailStart;
      const tailStart = lastGraphemeStart(children, state.tailStart);
      const fragments = [...state.fragments,
        fragment(children.slice(state.text.length), state.text.length, streaming)];
      // A final delta may add one fragment; keep existing nodes intact while
      // settling so a selected earlier fragment remains copyable.
      const retired = streaming
        ? fragments.splice(0, Math.max(0, fragments.length - MAX_FRAGMENTS))
        : [];
      setState({
        text: children,
        prefix: joinsPrevious ? children : state.prefix + retired.map((fragment) => fragment.text).join(''),
        fragments: joinsPrevious ? [] : fragments,
        streaming,
        tailStart,
      });
    }
  }

  return <>{state.prefix}{state.fragments.map((fragment) => (
    <span key={fragment.offset} className="ai-stream-text-fragment"
      data-streaming={streaming || undefined} data-reveal={fragment.reveal || undefined}
      data-staggered={fragment.runs.length > 0 || undefined}>
      {fragment.runs.length > 0 ? fragment.runs.map((run, index) => (
        <span key={index} className="ai-stream-text-run" style={{ animationDelay: `${index * 24}ms` }}>{run}</span>
      )) : fragment.text}
    </span>
  ))}</>;
}

type MarkdownElement = NonNullable<ExtraProps['node']>;

/** Work on parsed text, never on raw Markdown delimiters or HTML strings. */
export function rehypeStreamingText() {
  return (tree: { children: MarkdownElement['children'] }) => {
    const visit = (parent: { children: MarkdownElement['children'] }): void => {
      parent.children = parent.children.map((node) => {
        if (node.type === 'text' && node.value.trim()) {
          return {
            type: 'element',
            tagName: 'span',
            properties: { dataStreamText: true },
            children: [node],
            position: node.position,
          };
        }
        // Preserve code/path interaction, code copying and code layout verbatim.
        if (node.type === 'element' && node.tagName !== 'code' && node.tagName !== 'pre') visit(node);
        return node;
      });
    };
    visit(tree);
  };
}
