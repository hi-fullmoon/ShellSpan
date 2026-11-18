export interface AiLocalFileReference {
  path: string;
  line?: number;
  column?: number;
}

const absolutePath = /^(?:\/$|(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\u0000-\u001f\u007f]+$)/iu;
const editorPosition = /:([1-9]\d*)(?::([1-9]\d*))?$/u;
const lineFragment = /#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L[1-9]\d*(?:C[1-9]\d*)?)?$/iu;

/** A Markdown file link or the literal value of an inline code span. */
export function aiLocalFileReference(
  value: string,
  source: 'link' | 'code',
  target: 'local' | 'remote' = 'local',
): AiLocalFileReference | undefined {
  let path = value;
  let position: RegExpExecArray | null = null;
  if (source === 'link') {
    position = lineFragment.exec(path);
    if (position) path = path.slice(0, position.index);
    if (/^file:\/\//iu.test(path)) {
      try {
        const url = new URL(path);
        if (url.hostname || url.search || url.hash) return;
        path = url.pathname.replace(/^\/(?=[a-z]:\/)/iu, '');
      } catch {
        return;
      }
    }
  }
  if (!absolutePath.test(path)) return;
  if (!position && target === 'local') {
    position = editorPosition.exec(path);
    if (position) path = path.slice(0, position.index);
  }
  if (source === 'link') {
    try {
      path = decodeURIComponent(path);
    } catch {
      return;
    }
  }
  if (!absolutePath.test(path)) return;
  const line = position ? Number(position[1]) : undefined;
  const column = position?.[2] ? Number(position[2]) : undefined;
  const validPosition = (part: number | undefined) => part === undefined || part <= 0x7fffffff;
  if (!validPosition(line) || !validPosition(column)) return;
  return { path, line, column };
}
