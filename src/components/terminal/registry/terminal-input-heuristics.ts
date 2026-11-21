export interface TrackedUserInputState {
  pendingUserInputText: string;
  submittedContinuationText: string;
  unverifiedUserSubmission: boolean;
}

export function hasKnownCredentialPrompt(recentOutputTail: string): boolean {
  const tail = recentOutputTail
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .trimEnd();
  return /(?:password|passphrase|one[- ]time (?:password|code)|verification code|otp|continue connecting|host key)[^\r\n]{0,160}[:?]\s*$/i.test(tail);
}

export function inputLineNeedsContinuation(value: string): boolean {
  const trimmed = value.trimEnd();
  if (!trimmed) return false;
  if (/(?:\\|`)\s*$/.test(value) || /(?:\||&&|\|\|)\s*$/.test(value)) return true;
  const heredoc = /<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  const delimiters: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const openingLine = value.split('\n', 1)[0];
  const isUnquotedAt = (offset: number): boolean => {
    let heredocQuote: "'" | '"' | null = null;
    let heredocEscaped = false;
    for (let index = 0; index < offset; index += 1) {
      const character = openingLine[index];
      if (heredocEscaped) {
        heredocEscaped = false;
      } else if (heredocQuote) {
        if (character === heredocQuote) heredocQuote = null;
        else if (character === '\\' && heredocQuote === '"') heredocEscaped = true;
      } else if (character === '\\') {
        heredocEscaped = true;
      } else if (character === "'" || character === '"') {
        heredocQuote = character;
      }
    }
    return heredocQuote === null && !heredocEscaped;
  };
  for (const match of openingLine.matchAll(heredoc)) {
    if (!isUnquotedAt(match.index ?? 0)) continue;
    delimiters.push({
      delimiter: match[1] ?? match[2] ?? match[3],
      stripTabs: match[0].startsWith('<<-'),
    });
  }
  if (delimiters.length > 0) {
    const bodyLines = value.split('\n').slice(1);
    let delimiterIndex = 0;
    for (const line of bodyLines) {
      const expected = delimiters[delimiterIndex];
      if (!expected) break;
      const candidate = expected.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === expected.delimiter) delimiterIndex += 1;
    }
    if (delimiterIndex < delimiters.length) return true;
  }
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const closers: string[] = [];
  const matchingCloser: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (quote) {
      if (character === '\\' && quote === '"') escaped = true;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (matchingCloser[character]) {
      closers.push(matchingCloser[character]);
    } else if (closers[closers.length - 1] === character) {
      closers.pop();
    }
  }
  return quote !== null
    || closers.length > 0
    || /(?:\bthen|\bdo|\belse|\bcase\s+\S+\s+in)\s*$/i.test(trimmed);
}

export function applyTrackedUserInput(state: TrackedUserInputState, data: string): void {
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === '\u001b') {
      if (data[index + 1] === '[') {
        index += 2;
        while (index < data.length && !/[A-Za-z~]/.test(data[index])) index += 1;
      }
      continue;
    }
    if (character === '\u0003') {
      state.submittedContinuationText = '';
      state.pendingUserInputText = '';
    } else if (character === '\u0015') {
      state.pendingUserInputText = '';
    } else if (character === '\u007f' || character === '\b') {
      state.pendingUserInputText = [...state.pendingUserInputText].slice(0, -1).join('');
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && data[index + 1] === '\n') index += 1;
      const submittedInput = state.submittedContinuationText + state.pendingUserInputText;
      if (inputLineNeedsContinuation(submittedInput)) {
        state.submittedContinuationText = `${submittedInput}\n`;
      } else {
        if (submittedInput.trim()) state.unverifiedUserSubmission = true;
        state.submittedContinuationText = '';
      }
      state.pendingUserInputText = '';
    } else if (character === '\t' || character >= ' ') {
      state.pendingUserInputText += character;
    }
  }
}
