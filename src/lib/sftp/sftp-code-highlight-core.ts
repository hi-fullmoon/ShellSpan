import hljs from 'highlight.js/lib/common';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

hljs.registerLanguage('dart', dart);
hljs.registerLanguage('dockerfile', dockerfile);

/** Returns only highlight.js-generated, escaped markup; callers retain the original source. */
export function highlightSftpSource(content: string, language: string): string | null {
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
