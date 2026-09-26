import { useMemo, useState, type ComponentType } from 'react';
import { diffLines, parsePatch } from 'diff';
import hljs from 'highlight.js/lib/common';
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  Code2Icon,
  CopyIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  PanelRightOpenIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
  AI_STATE_DOT_CLASS,
  AI_TOOL_ROW_CLASS,
} from './ai-style-classes';

export type AiToolVariant =
  | 'terminal'
  | 'read'
  | 'search'
  | 'web'
  | 'write'
  | 'edit'
  | 'code'
  | 'plan'
  | 'generic';

type ToolNode = AiConversationNodeOf<'tool'>;
type UnknownRecord = Record<string, unknown>;

const DETAIL_LIMIT = 64 * 1024;
const INLINE_DIFF_LIMIT = 32 * 1024;
const INLINE_DIFF_TIMEOUT_MS = 50;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function firstString(record: UnknownRecord | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function firstNumber(record: UnknownRecord | null, keys: readonly string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function bounded(value: string): string {
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT)}\n…` : value;
}

function outputText(node: ToolNode): string {
  if (node.output === null) return '';
  if (typeof node.output === 'string') return node.output;
  const record = asRecord(node.output);
  const direct = firstString(record, [
    'output', 'stdout', 'content', 'text', 'result', 'body', 'data', 'message',
  ]);
  const stderr = firstString(record, ['stderr', 'error']);
  if (direct && stderr && direct !== stderr) return `${direct}\n${stderr}`;
  return direct ?? stderr ?? formatToolValue(node.output);
}

function classifyAiToolName(name: string): AiToolVariant {
  const normalized = name.toLowerCase().replace(/[.\-]/gu, '_');
  if (/(web_search|web_fetch|http|browser|url)/u.test(normalized)) return 'web';
  if (/(grep|glob|search|find_files|find_text)/u.test(normalized)) return 'search';
  if (/(read|cat|inspect_file|list_directory|list_files)/u.test(normalized)) return 'read';
  if (/(apply_patch|str_replace|edit|patch)/u.test(normalized)) return 'edit';
  if (/(write|create_file|save_file)/u.test(normalized)) return 'write';
  if (/(run_code|python|javascript|typescript|execute_code)/u.test(normalized)) return 'code';
  if (/(terminal|shell|bash|pwsh|command|exec|ssh)/u.test(normalized)) return 'terminal';
  return 'generic';
}

const EXACT_TOOL_VARIANTS: Readonly<Record<string, AiToolVariant>> = {
  apply_patch: 'edit',
  exec_command: 'terminal',
  kill_process: 'terminal',
  list_directory: 'read',
  update_plan: 'plan',
  probe_http: 'web',
  read_file: 'read',
  read_terminal: 'terminal',
  run_terminal_command: 'terminal',
  search_text: 'search',
  terminal_execute: 'terminal',
  wait_process: 'terminal',
  wait_terminal: 'terminal',
  write_file: 'write',
  write_stdin: 'terminal',
  write_terminal_input: 'terminal',
};

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[.\-]/gu, '_');
}

export function classifyAiTool(name: string, nativeName?: string | null): AiToolVariant {
  const exactPublicVariant = EXACT_TOOL_VARIANTS[normalizedToolName(name)];
  if (exactPublicVariant) return exactPublicVariant;
  const publicVariant = classifyAiToolName(name);
  if (publicVariant !== 'generic' || !nativeName) return publicVariant;
  return EXACT_TOOL_VARIANTS[normalizedToolName(nativeName)] ?? 'generic';
}

function iconFor(variant: AiToolVariant): ComponentType<React.SVGProps<SVGSVGElement>> {
  switch (variant) {
    case 'terminal': return SquareTerminalIcon;
    case 'read': return FileTextIcon;
    case 'search': return SearchIcon;
    case 'web': return GlobeIcon;
    case 'write': return FilePenLineIcon;
    case 'edit': return FileSearchIcon;
    case 'code': return Code2Icon;
    case 'plan': return ListTodoIcon;
    case 'generic': return SparklesIcon;
  }
}

function titleKey(variant: AiToolVariant): LocaleKey {
  return `ai.workspace.tool.title.${variant}` as LocaleKey;
}

function toolSummary(node: ToolNode, variant: AiToolVariant): string {
  if (node.state === 'failed' || node.state === 'rejected') {
    const failure = node.error ?? outputText(node);
    if (failure) return failure.split('\n')[0] ?? failure;
  }
  const input = asRecord(node.input);
  const path = variant === 'write' || variant === 'edit' ? toolFilePath(node) : null;
  if (path) return path.split('\n')[0] ?? path;
  const keys: Record<AiToolVariant, readonly string[]> = {
    terminal: ['description', 'explanation', 'command', 'cmd'],
    read: ['path', 'file_path', 'filePath', 'url'],
    search: ['query', 'pattern', 'path'],
    web: ['query', 'url'],
    write: ['path', 'file_path', 'filePath'],
    edit: ['path', 'file_path', 'filePath'],
    code: ['description', 'language'],
    plan: ['explanation'],
    generic: ['description', 'explanation', 'summary', 'intent'],
  };
  const inputSummary = firstString(input, keys[variant]);
  return inputSummary?.split('\n')[0]
    ?? (node.summary ? node.summary.split('\n')[0] : undefined)
    ?? node.title
    ?? node.name;
}

function toolTitle(
  node: ToolNode,
  variant: AiToolVariant,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (node.title === 'Agent orchestration') return t('ai.workspace.tool.title.orchestration');
  if (variant !== 'generic' || !node.title || node.title === node.name || node.title === node.nativeName) {
    return t(titleKey(variant));
  }
  return node.title;
}

function CappedText({ text, maxLines = 8 }: { text: string; maxLines?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => {
    const result = bounded(text).split(/\r?\n/u);
    // A final line terminator ends the previous line; it is not another row.
    if (result.length > 1 && result[result.length - 1] === '') result.pop();
    return result;
  }, [text]);
  if (expanded || lines.length <= maxLines) {
    return (
      <>
        {lines.map((line, index) => <div key={index} className="ai-block-line min-h-[18px] whitespace-pre">{line || '\u00a0'}</div>)}
        {lines.length > maxLines && (
          <button type="button" className="ai-block-fold block w-full cursor-pointer p-0 text-left" onClick={() => setExpanded(false)}>
            {t('ai.workspace.tool.collapse')}
          </button>
        )}
      </>
    );
  }
  const head = Math.ceil(maxLines / 2);
  const tail = Math.floor(maxLines / 2);
  const hidden = lines.length - head - tail;
  return (
    <>
      {lines.slice(0, head).map((line, index) => (
        <div key={`head-${index}`} className="ai-block-line min-h-[18px] whitespace-pre">{line || '\u00a0'}</div>
      ))}
      <button type="button" className="ai-block-fold block w-full cursor-pointer p-0 text-left" onClick={() => setExpanded(true)}>
        {t('ai.workspace.tool.expand', { count: hidden })}
      </button>
      {lines.slice(-tail).map((line, index) => (
        <div key={`tail-${index}`} className="ai-block-line min-h-[18px] whitespace-pre">{line || '\u00a0'}</div>
      ))}
    </>
  );
}

export function AiToolCopyButton({ text, label }: { readonly text: string; readonly label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ai-tool-copy-button"
            aria-label={copied ? t('common.copied') : (label ?? t('common.copy'))}
            onClick={() => {
              if (!navigator.clipboard || copied) return;
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_000);
              }).catch(() => undefined);
            }}
          />
        )}
      >
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? t('common.copied') : (label ?? t('common.copy'))}</TooltipContent>
    </Tooltip>
  );
}

function TerminalSurface({ node, compact, showCopyActions }: { node: ToolNode; compact: boolean; showCopyActions: boolean }) {
  const { t } = useI18n();
  const [commandExpanded, setCommandExpanded] = useState(false);
  const input = asRecord(node.input);
  const output = outputText(node);
  const command = firstString(input, ['command', 'cmd', 'script']) ?? formatToolValue(node.input);
  const displayCommand = command || node.name;
  const outputRecord = asRecord(node.output);
  const exitCode = firstNumber(outputRecord, ['exitCode', 'exit_code', 'code']);
  const cwd = firstString(input, ['cwd', 'workdir', 'workingDirectory'])
    ?? node.target?.cwd
    ?? node.target?.label
    ?? '$';
  return (
    <div className="ai-terminal-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="terminal" data-running={node.state === 'running' || undefined}>
      <div className="ai-terminal-header flex min-w-0 items-start gap-2 py-[9px] pr-1 pl-3.5">
        <span className={cn(AI_STATE_DOT_CLASS, 'mt-1.5')} data-state={node.state} aria-hidden="true" />
        <span className="ai-terminal-cwd shrink-0">{cwd}</span>
        <button
          type="button"
          className="ai-terminal-command min-w-0 flex-1 cursor-pointer p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={commandExpanded}
          aria-label={t(commandExpanded ? 'ai.workspace.tool.collapseCommand' : 'ai.workspace.tool.expandCommand')}
          onClick={() => setCommandExpanded((expanded) => !expanded)}
        >
          {displayCommand}
        </button>
        {exitCode !== null && exitCode !== 0 && <span className="ai-terminal-exit shrink-0">exit {exitCode}</span>}
        {showCopyActions && node.state !== 'running' && output && <AiToolCopyButton text={output} label={t('ai.workspace.tool.copyOutput')} />}
      </div>
      {node.state !== 'running' && (
        <div className="ai-terminal-output relative m-0 max-w-full">
          <div className="max-h-65 max-w-full overflow-auto px-3.5 py-3 whitespace-pre">
            {output ? <CappedText text={output} maxLines={compact ? 8 : Number.POSITIVE_INFINITY} /> : t('ai.workspace.tool.noOutput')}
          </div>
        </div>
      )}
    </div>
  );
}

function ReadSurface({ node, compact, showCopyActions }: { node: ToolNode; compact: boolean; showCopyActions: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const label = firstString(input, ['path', 'file_path', 'filePath']) ?? node.summary ?? node.name;
  const output = outputText(node);
  const lines = bounded(output).split('\n');
  const shown = compact && lines.length > 8
    ? [...lines.slice(0, 4), `… ${lines.length - 8} lines …`, ...lines.slice(-4)]
    : lines;
  return (
    <div className="ai-read-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="read">
      <div className="ai-block-banner flex min-w-0 items-start gap-2 py-[9px] pr-1 pl-3.5">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {showCopyActions && node.state !== 'running' && output && <AiToolCopyButton text={output} label={t('ai.workspace.tool.copyOutput')} />}
      </div>
      <pre className="ai-read-lines m-0 max-h-65 max-w-full overflow-auto px-3.5 py-3 whitespace-pre">
        {shown.map((line, index) => (
          <span key={index} className="ai-read-line grid min-h-[18px] grid-cols-[34px_minmax(max-content,1fr)]">
            <span className="ai-read-line-number" aria-hidden="true">{index + 1}</span>
            <span>{line || '\u00a0'}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function SearchSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const input = asRecord(node.input);
  const query = firstString(input, ['query', 'pattern']) ?? node.summary ?? node.name;
  const lines = bounded(outputText(node)).split('\n').filter(Boolean);
  const shown = compact && lines.length > 8
    ? [...lines.slice(0, 4), `… ${lines.length - 8} results …`, ...lines.slice(-4)]
    : lines;
  return (
    <div className="ai-search-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="search">
      <div className="ai-block-banner flex min-w-0 items-center gap-1 truncate px-3.5 py-[9px]"><SearchIcon aria-hidden="true" />{query}</div>
      <div className="ai-search-results m-0 flex max-h-65 max-w-full flex-col gap-1 overflow-auto px-3.5 py-3">
        {shown.map((line, index) => <div key={index} className="ai-search-result min-w-0 [overflow-wrap:anywhere]">{line}</div>)}
      </div>
    </div>
  );
}

interface WebSource {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

function webSources(value: unknown): readonly WebSource[] {
  const record = asRecord(value);
  const raw = Array.isArray(value) ? value : Array.isArray(record?.sources) ? record.sources : [];
  return raw.flatMap((item) => {
    const source = asRecord(item);
    const url = firstString(source, ['url', 'href', 'link']);
    if (!url) return [];
    return [{
      url,
      title: firstString(source, ['title', 'name']) ?? url,
      snippet: firstString(source, ['snippet', 'description', 'text']) ?? '',
    }];
  });
}

function WebSurface({ node }: { node: ToolNode }) {
  const input = asRecord(node.input);
  const sources = webSources(node.output);
  const url = firstString(input, ['url']);
  const answer = firstString(asRecord(node.output), ['answer', 'summary']);
  return (
    <div className="ai-web-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="web">
      <div className="ai-block-banner flex min-w-0 items-center gap-1 truncate px-3.5 py-[9px]"><GlobeIcon aria-hidden="true" />{url ?? node.summary ?? node.name}</div>
      {answer && <p className="ai-web-answer m-0 px-3.5 pt-3 pb-1">{answer}</p>}
      {sources.length > 0 ? (
        <div className="ai-web-sources flex min-w-0 flex-col p-2">
          {sources.map((source, index) => (
            <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noreferrer" className="ai-web-source flex min-w-0 flex-col p-1.5">
              <span className="min-w-0 truncate">{source.title}</span>
              {source.snippet && <small className="min-w-0 truncate">{source.snippet}</small>}
            </a>
          ))}
        </div>
      ) : (
        <pre className="ai-detail-code m-0 min-w-0 max-w-full overflow-x-auto p-4 whitespace-pre-wrap break-words">{bounded(outputText(node))}</pre>
      )}
    </div>
  );
}

interface DiffHunk {
  readonly oldStart?: number;
  readonly newStart?: number;
  readonly path: string;
  readonly lines: readonly DiffLine[];
  readonly exact: boolean;
}

interface DiffLine {
  readonly number?: number;
  readonly kind: 'context' | 'removed' | 'added';
  readonly text: string;
}

interface DiffModel {
  readonly hunks: readonly DiffHunk[];
  readonly totalsKnown: boolean;
}

function contentLines(text: string): readonly string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function lineTokens(text: string): readonly string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function textDiffLines(oldText: string | null, newText: string): Pick<DiffHunk, 'lines' | 'exact'> {
  if (oldText === null) {
    return { lines: contentLines(newText).map((text): DiffLine => ({ kind: 'added', text })), exact: true };
  }
  const oldTokens = lineTokens(oldText);
  const newTokens = lineTokens(newText);
  let prefix = 0;
  while (prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix] === newTokens[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < oldTokens.length - prefix && suffix < newTokens.length - prefix
    && oldTokens[oldTokens.length - suffix - 1] === newTokens[newTokens.length - suffix - 1]) {
    suffix += 1;
  }
  const contextLine = (token: string): DiffLine => ({
    kind: 'context', text: token.endsWith('\n') ? token.slice(0, -1) : token,
  });
  const before = oldTokens.slice(0, prefix).map(contextLine);
  const after = suffix === 0 ? [] : oldTokens.slice(-suffix).map(contextLine);
  const oldMiddle = oldTokens.slice(prefix, oldTokens.length - suffix).join('');
  const newMiddle = newTokens.slice(prefix, newTokens.length - suffix).join('');
  const changes = oldMiddle.length + newMiddle.length > INLINE_DIFF_LIMIT
    ? undefined
    : diffLines(oldMiddle, newMiddle, { timeout: INLINE_DIFF_TIMEOUT_MS });
  const middle = changes?.flatMap((change): DiffLine[] => {
    const kind: DiffLine['kind'] = change.added ? 'added' : change.removed ? 'removed' : 'context';
    return contentLines(change.value).map((text) => ({ kind, text }));
  }) ?? [
    ...contentLines(oldMiddle).map((text): DiffLine => ({ kind: 'removed', text })),
    ...contentLines(newMiddle).map((text): DiffLine => ({ kind: 'added', text })),
  ];
  return { lines: [...before, ...middle, ...after], exact: changes !== undefined };
}

function diffStat(model: DiffModel): string | null {
  if (!model.totalsKnown || model.hunks.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of model.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1;
      if (line.kind === 'removed') removed += 1;
    }
  }
  return `+${added} -${removed}`;
}

function firstPath(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const path = firstString(asRecord(value), ['path', 'file_path', 'filePath']);
    if (path) return path;
  }
  return null;
}

function toolFilePath(node: ToolNode): string | null {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  return firstString(input, ['path', 'file_path', 'filePath'])
    ?? firstString(output, ['path', 'file_path', 'filePath'])
    ?? firstPath(input?.preconditions)
    ?? firstPath(output?.files);
}

function structuredDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const output = asRecord(node.output);
  const diffs = Array.isArray(output?.diffs) ? output.diffs : null;
  if (!diffs) return [];
  return diffs.flatMap((value) => {
    const hunk = asRecord(value);
    const path = firstString(hunk, ['path', 'file_path']);
    const oldText = hunk?.oldText ?? hunk?.old_string ?? null;
    const newText = hunk?.newText ?? hunk?.new_string;
    return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
      ? [{ path, ...textDiffLines(oldText, newText) }]
      : [];
  });
}

function unifiedDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const unifiedDiff = firstString(output, ['diff']) ?? firstString(input, ['patch']);
  if (!unifiedDiff || unifiedDiff.length > DETAIL_LIMIT) return [];
  try {
    const fallbackPath = toolFilePath(node);
    return parsePatch(unifiedDiff).flatMap((patch) => patch.hunks.map((hunk) => {
      return {
        path: fallbackPath ?? patch.newFileName ?? patch.oldFileName ?? node.name,
        exact: true,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        lines: hunk.lines.flatMap((line): DiffLine[] => {
          const kind = line.startsWith('-') ? 'removed' : line.startsWith('+') ? 'added'
            : line.startsWith(' ') ? 'context' : null;
          return kind ? [{ kind, text: line.slice(1) }] : [];
        }),
      };
    }));
  } catch {
    return [];
  }
}

function directDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const input = asRecord(node.input);
  const path = toolFilePath(node);
  const oldText = input?.old_string ?? input?.oldText ?? null;
  const newText = input?.new_string ?? input?.newText ?? input?.content;
  return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
    ? [{ path, ...textDiffLines(oldText, newText) }]
    : [];
}

function diffModel(node: ToolNode): DiffModel {
  const structured = structuredDiffHunks(node);
  if (structured.length > 0) return { hunks: structured, totalsKnown: structured.every((hunk) => hunk.exact) };
  const unified = unifiedDiffHunks(node);
  if (unified.length > 0) return { hunks: unified, totalsKnown: true };
  const direct = directDiffHunks(node);
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const precondition = asRecord(input?.precondition);
  const replacesUnknownContent = output?.operation === 'replace'
    || typeof precondition?.sha256 === 'string';
  return { hunks: direct, totalsKnown: direct.length > 0 && direct.every((hunk) => hunk.exact) && !replacesUnknownContent };
}

function shownDiffLines(lines: readonly DiffLine[], compact: boolean): readonly DiffLine[] {
  if (!compact || lines.length <= 16) return lines;
  const firstChange = lines.findIndex((line) => line.kind !== 'context');
  const start = Math.max(0, firstChange - 3);
  const preview = lines.slice(start, start + 16);
  if (preview.some((line) => line.kind === 'removed') && preview.some((line) => line.kind === 'added')) {
    return preview;
  }
  const removed: number[] = [];
  const added: number[] = [];
  for (let index = 0; index < lines.length && (removed.length < 8 || added.length < 8); index += 1) {
    if (lines[index].kind === 'removed' && removed.length < 8) removed.push(index);
    if (lines[index].kind === 'added' && added.length < 8) added.push(index);
  }
  if (removed.length === 0 || added.length === 0) return preview;
  return [...removed, ...added].sort((left, right) => left - right).map((index) => lines[index]);
}

function DiffSurface({ node, compact, model }: { node: ToolNode; compact: boolean; model?: DiffModel }) {
  const { t } = useI18n();
  const currentModel = useMemo(() => model ?? diffModel(node), [model, node]);
  const hunks = useMemo(() => currentModel.hunks.map((hunk) => {
    let oldNumber = hunk.oldStart ?? 1;
    let newNumber = hunk.newStart ?? 1;
    return { ...hunk, lines: hunk.lines.map((line) => {
      const number = line.kind === 'removed' ? oldNumber : newNumber;
      if (line.kind !== 'added') oldNumber += 1;
      if (line.kind !== 'removed') newNumber += 1;
      return { ...line, number };
    }) };
  }), [currentModel]);
  if (hunks.length === 0) return <IoSurface node={node} compact={compact} />;
  return (
    <div className="ai-diff-block my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col gap-px overflow-hidden" data-ai-tool-view="diff">
      {hunks.map((hunk, index) => (
        <section key={`${hunk.path}:${index}`} className="min-w-0 max-w-full">
          <div className="ai-block-banner flex min-w-0 items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate">{hunk.path}</span>
            {hunk.exact && currentModel.totalsKnown && <span className="ai-diff-counts shrink-0">
              <span data-diff-count="added">+{hunk.lines.filter((line) => line.kind === 'added').length}</span>{' '}
              <span data-diff-count="removed">-{hunk.lines.filter((line) => line.kind === 'removed').length}</span>
            </span>}
          </div>
          {!hunk.exact && <div className="px-2.5 py-1 text-xs text-muted-foreground" data-diff-simplified>
            {t('ai.workspace.tool.diffSimplified')}
          </div>}
          <pre className="ai-diff-body m-0 min-w-0 max-h-65 max-w-full overflow-auto whitespace-pre" tabIndex={0}>
            <code className="ai-diff-lines">
            {shownDiffLines(hunk.lines, compact).map((line, lineIndex) => (
              <span key={lineIndex} data-diff={line.kind}>
                <span className="ai-diff-line-number" aria-hidden="true">{line.number}</span>
                <DiffCode text={line.text} path={hunk.path} />
              </span>
            ))}
            </code>
          </pre>
        </section>
      ))}
    </div>
  );
}

function DiffCode({ text, path }: { text: string; path: string }) {
  const html = useMemo(() => {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const language = ({ tsx: 'typescript', jsx: 'javascript', vue: 'xml', svg: 'xml', mjs: 'javascript', cjs: 'javascript' } as Record<string, string>)[extension] ?? extension;
    if (text.length > 10_000 || !hljs.getLanguage(language)) return null;
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }, [text, path]);
  // Only highlight.js-generated, escaped markup is inserted; unknown languages stay plain text.
  return html === null ? <span className="ai-diff-code table-cell px-3">{text || '\u00a0'}</span>
    : <span className="ai-diff-code table-cell px-3" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />;
}

function CodeSurface({ node, showCopyActions }: { node: ToolNode; showCopyActions: boolean }) {
  const input = asRecord(node.input);
  const code = firstString(input, ['code', 'program', 'script']) ?? formatToolValue(node.input);
  const language = firstString(input, ['language', 'lang']) ?? 'code';
  return (
    <div className="ai-code-block ai-tool-code-block relative my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="code">
      <div className="ai-code-block-banner flex min-w-0 items-center justify-between gap-3 px-3.5 py-[9px]">
        <span className="ai-code-block-language min-w-0 truncate">{language}</span>
        {showCopyActions && <AiToolCopyButton text={code} />}
      </div>
      <pre className="ai-code-block-pre m-0 max-w-full overflow-x-auto p-4 whitespace-pre-wrap break-all"><code>{bounded(code)}</code></pre>
      {node.output !== null && (
        <div className="ai-io-section grid max-h-[150px] grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3.5 overflow-auto px-4 py-3">
          <span className="ai-io-label">OUT</span>
          <pre className="ai-io-text m-0 min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">{bounded(outputText(node))}</pre>
        </div>
      )}
    </div>
  );
}

function IoSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const input = bounded(formatToolValue(node.input));
  const output = bounded(outputText(node));
  return (
    <div className="ai-io-card my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col overflow-hidden" data-ai-tool-view="generic">
      {input && (
        <div className="ai-io-section grid max-h-[150px] grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3.5 overflow-auto px-4 py-3">
          <span className="ai-io-label">IN</span>
          <pre className="ai-io-text m-0 min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">{compact ? input.slice(0, 8_192) : input}</pre>
        </div>
      )}
      {input && output && <span className="ai-io-divider" aria-hidden="true" />}
      {output && (
        <div className="ai-io-section grid max-h-[150px] grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3.5 overflow-auto px-4 py-3">
          <span className="ai-io-label">OUT</span>
          <pre className="ai-io-text m-0 min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]" data-error={node.state === 'failed' || undefined}>
            {compact ? output.slice(0, 8_192) : output}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AiToolExpandedContent({
  node,
  compact = false,
  showCopyActions = true,
  diffModel: precomputedDiff,
}: {
  readonly node: ToolNode;
  readonly compact?: boolean;
  readonly showCopyActions?: boolean;
  readonly diffModel?: DiffModel;
}) {
  const variant = classifyAiTool(node.name, node.nativeName);
  switch (variant) {
    case 'terminal': return <TerminalSurface node={node} compact={compact} showCopyActions={showCopyActions} />;
    case 'read': return <ReadSurface node={node} compact={compact} showCopyActions={showCopyActions} />;
    case 'search': return <SearchSurface node={node} compact={compact} />;
    case 'web': return <WebSurface node={node} />;
    case 'write':
    case 'edit': return <DiffSurface node={node} compact={compact} model={precomputedDiff} />;
    case 'code': return <CodeSurface node={node} showCopyActions={showCopyActions} />;
    case 'plan':
    case 'generic': return <IoSurface node={node} compact={compact} />;
  }
}

export function AiToolRow({
  node,
  onInspect,
}: {
  readonly node: ToolNode;
  readonly onInspect?: (node: ToolNode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const variant = classifyAiTool(node.name, node.nativeName);
  const Icon = iconFor(variant);
  const stateKey = `ai.workspace.tool.${node.state}` as LocaleKey;
  const rawSummary = toolSummary(node, variant);
  const summary = node.state === 'failed' || node.state === 'rejected'
    ? aiErrorMessage(rawSummary, t)
    : rawSummary === 'Agent orchestration'
      ? t('ai.workspace.tool.title.orchestration')
      : rawSummary;
  const title = toolTitle(node, variant, t);
  const model = useMemo(() => variant === 'write' || variant === 'edit' ? diffModel(node) : null, [node, variant]);
  const changeStat = model ? diffStat(model) : null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-tool-row-root flex min-w-0 flex-col"
        data-tool-state={node.state}
        data-tool-variant={variant}
        data-tool-fallback={variant === 'generic' || undefined}
      >
        <span className="sr-only" role="status">{t(stateKey)}</span>
        <CollapsibleTrigger
          render={(
            <button
              type="button"
              className={AI_TOOL_ROW_CLASS}
              data-ai-node-action=""
              aria-label={`${title}: ${summary}${changeStat ? ` ${changeStat}` : ''}`}
            />
          )}
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            {node.state === 'failed' || node.state === 'rejected'
              ? <span className={AI_STATE_DOT_CLASS} data-state="failed" />
              : node.state === 'approval'
                ? <ShieldAlertIcon />
                : <Icon />}
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={AI_DISCLOSURE_TITLE_CLASS}>{title}</span>
          <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
          <span
            className={AI_DISCLOSURE_SUMMARY_CLASS}
            data-error={node.state === 'failed' || node.state === 'rejected' || undefined}
          >
            {summary}
          </span>
          {(changeStat || node.durationMs !== null) && (
            <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              {changeStat && <span className="ai-tool-diff-stat">{changeStat}</span>}
              {node.durationMs !== null && (
                <span className="ai-tool-duration">{t('ai.workspace.durationMs', { duration: node.durationMs })}</span>
              )}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-tool-body flex min-w-0 max-w-full flex-col">
            <AiToolExpandedContent node={node} compact diffModel={model ?? undefined} />
            {onInspect && (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ai-tool-inspect mt-1 mr-1 mb-0.5 w-fit min-h-5 self-start px-2 py-0.5"
                      onClick={() => onInspect(node)}
                      aria-label={t('ai.workspace.details.openTool', { tool: node.name })}
                    />
                  )}
                >
                  <PanelRightOpenIcon data-icon="inline-start" />
                  {t('ai.workspace.tool.inspect')}
                </TooltipTrigger>
                <TooltipContent>{t('ai.workspace.details.toolTitle')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function ToolStateIcon({ node }: { readonly node: ToolNode }) {
  if (node.state === 'succeeded') return <CheckIcon aria-hidden="true" />;
  if (node.state === 'approval') return <ShieldAlertIcon aria-hidden="true" />;
  if (node.state === 'failed' || node.state === 'rejected') {
    return <span className={AI_STATE_DOT_CLASS} data-state="failed" aria-hidden="true" />;
  }
  return <BracesIcon aria-hidden="true" />;
}

export function toolOutputForCopy(node: ToolNode): string {
  return outputText(node);
}
