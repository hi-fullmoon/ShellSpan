export interface ParsedLogLine {
  raw: string;
  date?: string;
  time?: string;
  level?: string;
  target?: string;
  message?: string;
}

const LOG_LINE_REGEX =
  /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\[(DEBUG|INFO|WARN|ERROR)\](?:\[(.*?)\])?\s*(.*)$/;

function parseLogLine(line: string): ParsedLogLine {
  const match = LOG_LINE_REGEX.exec(line);
  if (!match) return { raw: line };
  return {
    raw: line,
    date: match[1],
    time: match[2],
    level: match[3],
    target: match[4],
    message: match[5],
  };
}

/** Retain completed entries, reparsing the final entry to handle partial lines and stack traces. */
export function createLogParser(): (content: string) => ParsedLogLine[] {
  let previous = '';
  let entries: ParsedLogLine[] = [];
  let lastEntryOffset = 0;
  return (content) => {
    if (content === previous) return entries;
    const append = previous.length > 0 && content.startsWith(previous);
    let offset = append ? lastEntryOffset : 0;
    const next = append ? entries.slice(0, -1) : [];
    let current: ParsedLogLine | undefined;
    const lines = content.slice(offset).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const sourceLine of lines) {
      const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
      const parsed = parseLogLine(line);
      if (parsed.level) {
        current = parsed;
        next.push(current);
        lastEntryOffset = offset;
      } else if (current) {
        current.message = `${current.message}\n${line}`;
        current.raw = `${current.raw}\n${line}`;
      } else {
        next.push(parsed);
        lastEntryOffset = offset;
      }
      offset += sourceLine.length + 1;
    }
    previous = content;
    entries = next;
    return entries;
  };
}
