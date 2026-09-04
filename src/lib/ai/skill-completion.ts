export interface ActiveSkillToken { start: number; end: number; query: string }

/** Whole whitespace-delimited slash tokens only; paths, URLs and selections are left alone. */
export function activeSkillToken(text: string, caret: number, selectionEnd = caret): ActiveSkillToken | null {
  if (caret !== selectionEnd || caret < 1 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/u.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/u.test(text[end])) end++;
  const token = text.slice(start, end);
  if (!/^\/[\p{L}\p{N}-]*$/u.test(token) || token.length > 65) return null;
  return { start, end, query: text.slice(start + 1, caret).toLowerCase() };
}

export function insertSkill(text: string, token: ActiveSkillToken, name: string): { text: string; caret: number } {
  const suffix = text.slice(token.end);
  const inserted = `/${name}${/^\s/u.test(suffix) ? '' : ' '}`;
  return { text: text.slice(0, token.start) + inserted + suffix, caret: token.start + inserted.length };
}
