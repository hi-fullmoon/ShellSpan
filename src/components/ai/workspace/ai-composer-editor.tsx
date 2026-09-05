import { useLayoutEffect, useRef, useState, type HTMLAttributes, type Ref } from 'react';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { registerPlainText } from '@lexical/plain-text';
import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection,
  $isRangeSelection, $isTextNode, $isElementNode, createEditor, TextNode,
  HISTORY_PUSH_TAG, KEY_DOWN_COMMAND, COMMAND_PRIORITY_CRITICAL,
  type EditorConfig, type NodeKey, type SerializedTextNode, type LexicalNode,
} from 'lexical';

/** Plain-text offsets shared by the editor and completion menus. */
export interface ComposerEditorHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly element: HTMLDivElement | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

class CommandNode extends TextNode {
  static getType() { return 'composer-command'; }
  static clone(node: CommandNode) { return new CommandNode(node.__text, node.__key); }
  constructor(text: string, key?: NodeKey) { super(text, key); }
  static importJSON(json: SerializedTextNode) { return new CommandNode(json.text).updateFromJSON(json); }
  exportJSON(): SerializedTextNode { return { ...super.exportJSON(), type: CommandNode.getType() }; }
  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add('ai-composer-command');
    element.dataset.composerCommand = this.getTextContent().slice(1);
    return element;
  }
  isTextEntity() { return true; }
}

function leaves(): LexicalNode[] {
  const result: LexicalNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isElementNode(node)) node.getChildren().forEach(visit);
    else result.push(node);
  };
  visit($getRoot());
  return result;
}

function selectionOffsets(): [number, number] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return [0, 0];
  const offset = (point: typeof selection.anchor) => {
    let total = 0;
    const target = point.getNode();
    if ($isElementNode(target)) {
      const preceding = target.getChildren().slice(0, point.offset);
      const first = target.getFirstDescendant();
      for (const node of leaves()) { if (node === first) break; total += node.getTextContentSize(); }
      return total + preceding.reduce((sum, node) => sum + node.getTextContentSize(), 0);
    }
    for (const node of leaves()) { if (node === target) return total + point.offset; total += node.getTextContentSize(); }
    return total;
  };
  const a = offset(selection.anchor), b = offset(selection.focus);
  return [Math.min(a, b), Math.max(a, b)];
}

function selectOffsets(start: number, end: number) {
  const paragraph = $getRoot().getFirstChild();
  if (!$isElementNode(paragraph)) return;
  const selection = paragraph.select(0, 0);
  const set = (point: typeof selection.anchor, offset: number) => {
    for (const node of leaves()) {
      const length = node.getTextContentSize();
      if ($isTextNode(node) && offset <= length) { point.set(node.getKey(), offset, 'text'); return; }
      if (offset === 0) { point.set(paragraph.getKey(), node.getIndexWithinParent(), 'element'); return; }
      offset -= length;
    }
    point.set(paragraph.getKey(), paragraph.getChildrenSize(), 'element');
  };
  set(selection.anchor, start); set(selection.focus, end);
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'onSelect' | 'onKeyDown'> {
  ref?: Ref<ComposerEditorHandle>;
  value: string;
  disabled?: boolean;
  placeholder: string;
  commandNames: readonly string[];
  onKeyDown?(event: KeyboardEvent): void;
  onChange(value: string): void;
  onSelectionChange(): void;
}

/** Lexical owns editing, history and token selection; persisted drafts remain plain text. */
export function AiComposerEditor({ ref, value, disabled, placeholder, commandNames, onChange, onSelectionChange, onKeyDown, onPaste, ...props }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef({ onChange, onSelectionChange, onKeyDown, commandNames });
  latest.current = { onChange, onSelectionChange, onKeyDown, commandNames };
  const [editor] = useState(() => createEditor({
    namespace: 'ai-composer', nodes: [CommandNode], onError: error => { throw error; },
  }));
  const [empty, setEmpty] = useState(!value);
  const offsets = useRef<[number, number]>([0, 0]);
  const text = useRef(value);
  useLayoutEffect(() => {
    editor.setRootElement(element.current);
    const removePlain = registerPlainText(editor);
    const removeHistory = registerHistory(editor, createEmptyHistoryState(), 300);
    // Run the composer's submit/completion policy before Lexical's Enter handling.
    const removeKeys = editor.registerCommand(KEY_DOWN_COMMAND, event => {
      latest.current.onKeyDown?.(event);
      return event.defaultPrevented;
    }, COMMAND_PRIORITY_CRITICAL);
    const removeTransform = editor.registerNodeTransform(TextNode, node => {
      if (node instanceof CommandNode || !node.isSimpleText() || editor.isComposing()) return;
      const content = node.getTextContent();
      const names = new Set(latest.current.commandNames);
      for (const match of content.matchAll(/(^|\s)(\/[\p{L}\p{N}-]+)(?=\s)/gu)) {
        if (!names.has(match[2].slice(1))) continue;
        const start = match.index + match[1].length;
        const pieces = node.splitText(start, start + match[2].length);
        const target = pieces[start === 0 ? 0 : 1];
        target.replace(new CommandNode(match[2]).setMode('token'));
        return;
      }
    });
    const removeUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const next = $getRoot().getTextContent();
        offsets.current = selectionOffsets();
        setEmpty(next.length === 0);
        if (next !== text.current) { text.current = next; latest.current.onChange(next); }
        latest.current.onSelectionChange();
      });
    });
    const handle: ComposerEditorHandle = {
      get value() { return text.current; },
      get selectionStart() { return offsets.current[0]; },
      get selectionEnd() { return offsets.current[1]; },
      get element() { return element.current; },
      focus() { editor.focus(); },
      setSelectionRange(start, end) { editor.update(() => selectOffsets(start, end), { discrete: true }); },
    };
    if (typeof ref === 'function') ref(handle); else if (ref) ref.current = handle;
    return () => {
      removeUpdate(); removeTransform(); removeKeys(); removeHistory(); removePlain(); editor.setRootElement(null);
      if (typeof ref === 'function') ref(null); else if (ref) ref.current = null;
    };
  }, [editor, ref]);
  useLayoutEffect(() => { editor.setEditable(!disabled); }, [editor, disabled]);
  useLayoutEffect(() => {
    if (editor.getEditorState().read(() => $getRoot().getChildrenSize() > 0 && $getRoot().getTextContent() === value)) return;
    text.current = value;
    editor.update(() => {
      const focused = document.activeElement === element.current;
      const paragraph = $createParagraphNode();
      const lines = value.split('\n');
      lines.forEach((line, index) => { if (index) paragraph.append($createLineBreakNode()); if (line) paragraph.append($createTextNode(line)); });
      $getRoot().clear().append(paragraph);
      if (focused) selectOffsets(value.length, value.length);
    }, { discrete: true, tag: HISTORY_PUSH_TAG });
  }, [editor, value]);
  return <div className="ai-composer-editor-wrap" onClick={event => { if (event.target === event.currentTarget && !disabled) editor.focus(); }}>
    <div {...props} onPasteCapture={event => { onPaste?.(event); if (event.defaultPrevented) event.stopPropagation(); }} ref={element} contentEditable={!disabled} suppressContentEditableWarning
      role="textbox" aria-multiline="true" aria-label={placeholder} aria-disabled={disabled || undefined}
      data-slot="input-group-control" data-composer-editor="" />
    {empty && <div className="ai-composer-placeholder" aria-hidden="true">{placeholder}</div>}
  </div>;
}
