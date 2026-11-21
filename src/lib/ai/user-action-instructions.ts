const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const MARKDOWN_BLOCK_PREFIX_RE = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|\|)/;
const INLINE_CODE_ONLY_RE = /^(`+)([^`\r\n]+)\1$/;
const CJK_OR_FULLWIDTH_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const SHELL_PROMPT_RE = /^\$\s+\S/;
const ENV_ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/;
const PATH_EXECUTABLE_RE = /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)\S+/;
const LOWERCASE_COMMAND_RE = /^[a-z][a-z0-9._+-]*(?:\s|$)/;
const POWERSHELL_CMDLET_RE = /^[A-Z][a-z]+-[A-Z][A-Za-z0-9]*(?:\s|$)/;
const SHELL_OPERATOR_RE = /(?:\s(?:&&|\|\||\|)\s|;\s+\S|\s(?:>>?|2>&1|<<<?)\s|\$\(|\$\{[A-Za-z_0-9]+\}|\$[?@#*$!0-9])/;
const CLI_FLAG_RE = /(?:^|\s)--?[A-Za-z][A-Za-z0-9_-]*(?:=|\s|$)/;
const SHELL_PATH_ARG_RE = /\s(?:\/[A-Za-z0-9._@~/-]+|\.{1,2}\/\S+|~\/\S+|[A-Za-z]:\\\S+)/;
const PROSE_SENTENCE_END_RE = /[.?!。？！：:]$/;

const UNMISTAKABLE_CLI_COMMANDS = new Set([
  'apt', 'apt-get', 'brew', 'cargo', 'chmod', 'chown', 'cp', 'curl', 'dnf', 'docker',
  'export', 'git', 'journalctl', 'kubectl', 'ls', 'mkdir', 'mv', 'nginx', 'npm', 'openssl',
  'pacman', 'pip', 'pip3', 'pnpm', 'podman', 'python3', 'rm', 'rmdir', 'rsync', 'scp',
  'ssh', 'ssh-add', 'ssh-keygen', 'sudo', 'systemctl', 'tar', 'ufw', 'unzip', 'wget',
  'yarn', 'yum', 'zip',
]);

function fenceFor(content: string): string {
  return content.includes('```') ? '~~~' : '```';
}

function wrapAsCodeBlock(content: string): string {
  const fence = fenceFor(content);
  return `${fence}\n${content}\n${fence}`;
}

function isStandaloneInlineCodeCommand(trimmed: string): string | null {
  const match = INLINE_CODE_ONLY_RE.exec(trimmed);
  if (!match) return null;
  const inner = match[2].trim();
  if (!inner) return null;
  if (/\s/.test(inner) || PATH_EXECUTABLE_RE.test(inner) || SHELL_OPERATOR_RE.test(inner)) {
    return inner;
  }
  return null;
}

function isBareShellCommand(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  if (lines.length > 1 && lines.slice(0, -1).some((line) => !line.trimEnd().endsWith('\\'))) {
    return false;
  }

  const joined = lines.map((line) => line.trim()).join(' ');
  if (!joined || MARKDOWN_BLOCK_PREFIX_RE.test(joined)) return false;
  if (CJK_OR_FULLWIDTH_RE.test(joined) || PROSE_SENTENCE_END_RE.test(joined)) return false;

  const withoutPrompt = SHELL_PROMPT_RE.test(joined) ? joined.replace(/^\$\s+/, '') : joined;
  const withoutEnv = withoutPrompt.replace(ENV_ASSIGNMENT_RE, '');
  const hasCommandStart =
    SHELL_PROMPT_RE.test(joined) ||
    PATH_EXECUTABLE_RE.test(withoutEnv) ||
    POWERSHELL_CMDLET_RE.test(withoutEnv) ||
    LOWERCASE_COMMAND_RE.test(withoutEnv);
  if (!hasCommandStart) return false;

  const hasShellSyntax =
    SHELL_PROMPT_RE.test(joined) ||
    ENV_ASSIGNMENT_RE.test(withoutPrompt) ||
    PATH_EXECUTABLE_RE.test(withoutEnv) ||
    POWERSHELL_CMDLET_RE.test(withoutEnv) ||
    SHELL_OPERATOR_RE.test(withoutPrompt) ||
    CLI_FLAG_RE.test(withoutPrompt) ||
    SHELL_PATH_ARG_RE.test(withoutPrompt);
  if (hasShellSyntax) return true;

  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  return tokens.length >= 2 && UNMISTAKABLE_CLI_COMMANDS.has(tokens[0]);
}

function formatParagraph(lines: readonly string[]): string {
  const trimmedLines = lines.map((line) => line.trim());
  if (trimmedLines.length === 1) {
    const inlineCode = isStandaloneInlineCodeCommand(trimmedLines[0]);
    if (inlineCode !== null) return wrapAsCodeBlock(inlineCode);
  }
  if (isBareShellCommand(lines)) {
    return wrapAsCodeBlock(lines.map((line) => line.trim()).join('\n'));
  }
  return lines.join('\n');
}

/**
 * Promote standalone unfenced or single-backtick command paragraphs in user-action
 * instructions to fenced code blocks so they render with dedicated copy controls.
 */
export function formatUserActionInstructions(instructions: string): string {
  const normalized = instructions.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];
  let activeFence: { char: string; length: number } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(formatParagraph(paragraph));
    paragraph = [];
  };

  for (const line of lines) {
    if (activeFence) {
      output.push(line);
      const closeMatch = FENCE_OPEN_RE.exec(line);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFence.char &&
        closeMatch[1].length >= activeFence.length &&
        line.trim().slice(closeMatch[1].length).trim() === ''
      ) {
        activeFence = null;
      }
      continue;
    }

    const openMatch = FENCE_OPEN_RE.exec(line);
    if (openMatch) {
      flushParagraph();
      activeFence = { char: openMatch[1][0], length: openMatch[1].length };
      output.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      output.push(line);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return output.join('\n');
}
